/* Module dependencies */
var mssql = require("mssql");
var jdb = require("jugglingdb");
var util = require("util");
var Parameters = require("./params");

var name = "mssql";

exports.name = name;
exports.initialize = function initializeSchema(schema, callback) {
  //need msnodesql installed, and a host server and a database
  if (!mssql || !schema.settings.host || !schema.settings.database){ return; }

  var config = {
    server: schema.settings.host,
    database: schema.settings.database,
    port: schema.settings.port,
    driver: schema.settings.driver
  };

  //if we have a username and password then we use a credential connection string
  if (schema.settings.username && schema.settings.password) {
    config.user = schema.settings.username;
    config.password = schema.settings.password;
  }

  if (!config.driver || config.driver && config.driver === "tedious") {
    config.options = schema.settings.options;
    config.pool = schema.settings.pool;
  }
  else if (config.driver === "msnodesql") {
    config.connectionString = schema.settings.connectionString;
  }

  var connection = new mssql.Connection(config, function(err){

    if (err) {
        throw err;
    }

    schema.connected = true;
    process.nextTick(callback);
  });

  schema.client = connection;
  schema.adapter = new MsSQL(schema.client);
  schema.adapter.schema = schema;
  schema.adapter.tableNameID = schema.settings.tableNameID;
  if (schema.settings.azure) schema.adapter.azure = true;
};

function MsSQL(client) {
  this.name = name;
  this._models = {};
  this._pkids = {};
  this._idxNames = {};
  this.client = client;
}

util.inherits(MsSQL, jdb.BaseSQL);

MsSQL.newline = "\r\n";

function wrapColumn(col) {
    var colRegex = /(\w*)\s*(DESC|ASC){0,1}/
    return col.replace(colRegex, "[$1] $2").trim();
}

MsSQL.prototype.query = function (sql, optionsOrCallback, Callback) {
  //debugger;
  var hasOptions = true;
  var options = null;
  var cb = null;
  if (typeof optionsOrCallback === "function") {
    hasOptions = false;
    cb = optionsOrCallback;
    // console.log(sql);
  } else {
    options = optionsOrCallback;
    cb = Callback;
    // console.log(options);
    // console.log(sql);
  }
  if (!this.schema.connected) {
    return this.schema.on('connected', function () {
      var request = this.schema.client.request();
      if (hasOptions) {
        if (options instanceof Parameters) {
          for (var i = 0; i < options.params.length; i++) {
            request.input(options.params[i].name, options.params[i].value);
          }
        }
        else {
          throw new Error(name + " invalid options passed to query");
        }
      }
      request.query(sql, cb);
    }.bind(this));
  }
  var client = this.client;
  var time = Date.now();
  var log = this.log;
  if (typeof cb !== 'function') {
    throw new Error('callback should be a function');
  }

  var innerCB = function (err, data) {
    if (log) log(sql, time);
    try {
        process.nextTick(cb.bind(null, err, data));
    } catch (e) {
        console.log(e.stack);
    }
  };

  var request = client.request();
  if (hasOptions) {
    if (options instanceof Parameters) {
      for (var i = 0; i < options.params.length; i++) {
        request.input(options.params[i].name, options.params[i].value);
      }
    }
    else {
      throw new Error(name + " invalid options passed to query");
    }
  }
  request.query(sql, innerCB);
};

MsSQL.prototype.disconnect = function disconnect() {
  this.client.close();
};

// MsSQL.prototype.command = function (sql, callback) {
//     return this.query(sql, callback);
// };

//params
// descr = {
//   model: ...
//   properties: ...
//   settings: ...
// }
MsSQL.prototype.define = function (descr) {
  if (!descr.settings) descr.settings = {};

  this._models[descr.model.modelName] = descr;

  //default pkid is "id"
  var id = "id";
  //override the default with another convention, 'TableName'ID, if defined in the adapter settings
  if (this.tableNameID) {
    id = descr.model.modelName + "ID";
  }
  //override both defaults if a primaryKey is specified in a property
  Object.keys(descr.properties).forEach(function(propName) {
    var propVal = descr.properties[propName];
    if (typeof propVal === "object" && propVal.primaryKey) {
      return id = propVal.name || propName;
    }
  });
  this._pkids[descr.model.modelName] = id;

  //track database index names for this model
  this._idxNames[descr.model.modelName] = [];
};

// MsSQL.prototype.defineProperty = function (model, prop, params) {
//   this._models[model].properties[prop] = params;
// };

/**
 * Must invoke callback(err, id)
 */
MsSQL.prototype.create = function (model, data, callback) {
  //debugger;
  var fieldsAndData = this.buildInsert(model, data);
  var tblName = this.tableEscaped(model);
  var sql = "INSERT INTO [dbo].[" + tblName + "] (" + fieldsAndData.fields + ")" + MsSQL.newline;
      sql += "VALUES (" + fieldsAndData.paramPlaceholders + ");" + MsSQL.newline;
      sql += "SELECT IDENT_CURRENT('" + tblName + "') AS insertId;";

  // console.log(sql);
  // console.log(fieldsAndData.params);
  this.query(sql, fieldsAndData.params, function (err, results) {
    //console.log(err);
    if (err) { return callback(err); }
    //console.log(results);
    //msnodesql will execute the callback for each statement that get's executed, we're only interested in the one that returns with the insertId
    if (results.length > 0 && results[0].insertId) {
      //console.log('new id: ' + results[0].insertId);
      callback(null, results[0].insertId);
    }
  });
};

MsSQL.prototype.updateOrCreate = function (model, data, callback) {
  //debugger;
  //console.log('updateOrCreate');
  var self = this;
  var props = this._models[model].properties;
  var tblName = this.tableEscaped(model);
  var modelPKID = this._pkids[model];
  //get the correct id of the item using the pkid that they specified
  var id = data[modelPKID];
  var fieldNames = [];
  var fieldValuesPlaceholders = [];
  var combined = [];
  var params = new Parameters();
  Object.keys(data).forEach(function (key) {
    if (props[key]) {
      //check for the "id" key also, for backwards compatibility with the jugglingdb hardcoded id system
      if (key !== "id" && key !== modelPKID) {
        var paramName = self.toDatabase(props[key], data[key], params);
        fieldNames.push("[" + key + "]");
        fieldValuesPlaceholders.push("(" + paramName + ")");
        combined.push(key + "=(" + paramName + ")");
      }
    }
  });
  var sql = "";
  if (id > 0) {
    self.exists(model, id, function(err, yn) {
      if (err) { return callback(err); }
      if (yn) {
        //update
        sql = "UPDATE [dbo].[" + tblName + "]" + MsSQL.newline;
        sql += "SET " + combined.join() + MsSQL.newline;
        sql += "WHERE [" + modelPKID + "] = (@id);" + MsSQL.newline;
        sql += "SELECT " + id + " AS pkid;";
        params.add("id", id);
      } else {
        //insert with identity_insert
        sql = "SET IDENTITY_INSERT [dbo].[" + tblName + "] ON;" + MsSQL.newline;
        sql += "INSERT INTO [dbo].[" + tblName + "] ([" + modelPKID + "]," + fieldNames.join() + ")" + MsSQL.newline;
        sql += "VALUES (" + id + "," + fieldValuesPlaceholders.join() + ");" + MsSQL.newline;
        sql += "SET IDENTITY_INSERT [dbo].[" + tblName + "] OFF;" + MsSQL.newline;
        sql += "SELECT " + id + " AS pkid;";
      }
      doQuery(sql, params);
    });
  } else {
    //insert
    sql = "INSERT INTO [dbo].[" + tblName + "] (" + fieldNames.join() + ")" + MsSQL.newline;
    sql += "VALUES (" + fieldValuesPlaceholders.join() + ");" + MsSQL.newline;
    sql += "SELECT IDENT_CURRENT('" + tblName + "') AS pkid;";
    doQuery(sql, params);
  }

  var doQuery = function(sql, params) {
    self.query(sql, params, function (err, results) {
      if (err) { return callback(err); }
      //msnodesql will execute the callback for each statement that get's executed, we're only interested in the one that returns with the pkid
      if (results.length > 0 && results[0].pkid) {
        data[modelPKID] = results[0].pkid;
        //#jdb id compatibility#
        data.id = results[0].pkid; //set the id property also, to play nice with the jugglingdb abstract class implementation.
        callback(err, data);
      }
    });
  }
};

//redundant, same functionality as "updateOrCreate" right now.  Maybe in the future some validation will happen here.
MsSQL.prototype.save = function (model, data, callback) {
  this.updateOrCreate(model, data, callback);
};

MsSQL.prototype.updateAttributes = function (model, id, data, cb) {
  var self = this;
  var tblName = this.tableEscaped(model);
  var modelPKID = this._pkids[model];
  //jugglingdb abstract class may have sent up a null value for this id if we aren't using the standard "id" name for the pkid.
  //  if that is the case then set the id to the correct value from the data using the actual pkid name.
  if (id === null) {
    id = data[modelPKID];
  } else {
    data[modelPKID] = id;
  }
  //console.log(id);
  this.exists(model, id, function(err, yn) {
    if (err) {
      console.log(err);
      return cb("An error occurred when checking for the existance of this record");
    }
    if (yn) {
      //only call this after verifying that the record exists, we don't want to create it if it doesn't.
      return self.updateOrCreate(model, data, cb);
    }
    return cb("A " + tblName + " doesn't exist with a " + modelPKID + " of " + id , id);
  });
};

MsSQL.prototype.exists = function (model, id, callback) {
  var tblName = this.tableEscaped(model);
  var modelPKID = this._pkids[model];
  var sql = "SELECT COUNT(*) cnt FROM [dbo].[" + tblName + "] WHERE [" + modelPKID + "] = (@id)";
  //console.log(sql);
  this.query(sql, new Parameters([{ name: "id", value: id }]), function (err, results) {
      if (err) return callback(err);
      callback(null, results[0].cnt >= 1);
  });
};

MsSQL.prototype.count = function (model, cb, where) {
  var sql = "SELECT COUNT(*) cnt FROM [dbo].[" + this.tableEscaped(model) + "]" + MsSQL.newline;
  var props = this._models[model].properties;

  var params = new Parameters();

  if (where) {
    sql += this.buildWhere(where, props, params) + MsSQL.newline;
  }

  this.query(sql, params, function (err, data) {
    if (err) { return cb(err); }
    cb(null, data[0].cnt);
  });

  return sql;
};

MsSQL.prototype.destroyAll = function(model, cb) {
  var sql = "DELETE FROM [dbo].[" + this.tableEscaped(model) + "]";
  this.query(sql, function(err, data) {
    //don't bother returning data, it's a delete statement
    if (err) { return cb(err); }
    cb(null);
  });
};

MsSQL.prototype.destroy = function(model, id, cb) {
  var sql = "DELETE FROM [dbo].[" + this.tableEscaped(model) + "]" + MsSQL.newline;
  sql += "WHERE [" + this._pkids[model] + "] = (@id)";
  this.query(sql, new Parameters([{ name: "id", value: id }]), function(err, data) {
    if (err) { return cb(err); }
    cb(null);
  });
};

MsSQL.prototype.find = function (model, id, callback) {
  //debugger;
  var tblName = this.tableEscaped(model);
  var modelPKID = this._pkids[model];
  var sql = "SELECT * FROM [dbo].[" + tblName + "] WHERE [" + modelPKID + "] = (@id)";
  //console.log(sql);
  this.query(sql, new Parameters([{ name: "id", value: id }]), function (err, results) {
    if (err) return callback(err);
    callback(null, this.fromDatabase(model, results[0]));
  }.bind(this));
};

MsSQL.prototype.buildInsert = function (model, data) {
  var insertIntoFields = [];
  var paramPlaceholders = [];
  var params = new Parameters();
  var props = this._models[model].properties;
  var modelPKID = this._pkids[model];
  //remove the pkid column if it's in the data, since we're going to insert a new record, not update an existing one.
  delete data[modelPKID];
  //delete the hardcoded id property that jugglindb automatically creates
  delete data.id
  Object.keys(data).forEach(function (key) {
    if (props[key]) {
      var paramName = this.toDatabase(props[key], data[key], params);
      insertIntoFields.push("[" + key + "]");
      paramPlaceholders.push("(" + paramName + ")");
    }
  }.bind(this));

  return { fields:insertIntoFields.join(), paramPlaceholders:paramPlaceholders.join(), params:params };
}

//unchanged from MySql adapter, credit to dgsan
function dateToMsSql(val) {
  return (val.getUTCMonth() + 1) + '-' +
    val.getUTCDate() + '-' +
    val.getUTCFullYear() + ' ' +
    fillZeros(val.getUTCHours()) + ':' +
    fillZeros(val.getUTCMinutes()) + ':' +
    fillZeros(val.getUTCSeconds()) + '.00';

  function fillZeros(v) {
    return v < 10 ? '0' + v : v;
  }
}

//toDatabase is used for formatting data when inserting/updating records
// it is also used when building a where clause for filtering selects
MsSQL.prototype.toDatabase = function (prop, val, params) {
  if (val === null || typeof val === 'undefined') {
    // return 'NULL';
    return null;
  }
  if (prop && prop.type.name === 'JSON') {
    return "@" + params.add(JSON.stringify(val));
  }
  if (prop && prop.type instanceof Array) {
    return "@" + params.add(JSON.stringify(val));
  }
  if (val.constructor && val.constructor.name === 'Object') {
    var operator = Object.keys(val)[0]
    val = val[operator];
    if (operator === 'between') {
      //the between operator is never used for insert/updates
      // therefore always pass the wrap=true parameter when formatting the values
      return this.toDatabase(prop, val[0], params) +
      ' AND ' +
      this.toDatabase(prop, val[1], true);
    } else if (operator == 'inq' || operator == 'nin') {
      //always wrap inq/nin values in single quotes when they are string types, it's never used for insert/updates
      if (!(val.propertyIsEnumerable('length')) && typeof val === 'object' && typeof val.length === 'number') { //if value is array
        var self = this;
        return val.map(function (item) {
          return self.toDatabase(prop, item, params);
        }).join(',');
      } else {
        return "@" + params.add(val);
      }
    } else if (operator === "max") {
      return val.field;
    }
  }
  if (prop && prop.type.name === 'Date') {
    if (!val) {
      return null;
      // return 'NULL';
    }
    if (!val.toISOString) {
      val = new Date(val);
    }
      else {
        val = val.toISOString();
    }
  }
  if (prop && prop.type.name == "Boolean") {
    return val ? 1 : 0;
  }

  return "@" + params.add(val);
};

MsSQL.prototype.fromDatabase = function (model, data) {
  if (!data) {
    return null;
  }
  //create an "id" property in the data for backwards compatibility with juggling-db
  data.id = data[this._pkids[model]];
  var props = this._models[model].properties;
  Object.keys(data).forEach(function (key) {
    var val = data[key];
    if (props[key]) {
      if (props[key].type.name === 'Boolean' && val !== null) {
        val = (true && val); //convert to a boolean type from number
      }
    }
    data[key] = val;
  });
  return data;
};

MsSQL.prototype.escapeName = function (name) {
  return name.replace(/\./g, '_');
};

MsSQL.prototype.escapeKey = function (key) {
  return key;
};

MsSQL.prototype.all = function (model, params, callback) {
  var sql = "SELECT * FROM [dbo].[" + this.tableEscaped(model) + "]" + MsSQL.newline;
  var self = this;
  var props = this._models[model].properties;
  var parameters = new Parameters();

  if (params) {
    if (params.where) {
      sql += this.buildWhere(params.where, props, parameters) + MsSQL.newline;
      //console.log(sql);
    }

    if (params.limit || params.skip) {
        if (!params.order) {
            params.order = this._pkids[model];
        }
    }

    if (params.order) {
      sql += this.buildOrderBy(params.order, params.skip, params.limit) + MsSQL.newline;
    }
  }

  this.query(sql, parameters, function (err, data) {
    if (err) return callback(err);

    //convert database types to js types
    var objs = data.map(function (obj) {
      return self.fromDatabase(model, obj);
    });

    //check for eager loading relationships
    if (params && params.include) {
        self._models[model].model.include(objs, params.include, callback);
    } else {
      callback(null, objs);
    }
  });

  return sql;
};

MsSQL.prototype.buildOrderBy = function (order, skip, limit) {
    if (typeof order === 'string') {
        order = [order];
    }

    order = order.map(function (item) {
        return wrapColumn(item);
    });

    var sql = 'ORDER BY ' + order.join(',');
    sql += ' OFFSET ' + (skip || 0) + ' ROWS ';

    if (limit) {
        sql += ' FETCH NEXT ' + limit + ' ROWS ONLY';
    }
    return sql

};

MsSQL.prototype.buildWhere = function(conds, props, params) {
  // debugger;
  var self = this;
  var cs = [];
  Object.keys(conds).forEach(function (key) {
    var keyEscaped = self.escapeKey(key);
    var val = self.toDatabase(props[key], conds[key], params);
    if (conds[key] === null) {
      cs.push(keyEscaped + ' IS NULL');
    } else if (conds[key].constructor.name === 'Object') {
      var condType = Object.keys(conds[key])[0];
      var sqlCond = keyEscaped;
      if ((condType == 'inq' || condType == 'nin') && val.length == 0) {
        cs.push(condType == 'inq' ? "0=1" : "0=0");
        return true;
      }
      if (condType === "max") {
        var tbl = conds[key].max.from;
        var subClause = conds[key].max.where;
        sqlCond += " = (SELECT MAX(" + val + ") FROM " + tbl;
        if (subClause) {
          sqlCond += " " + self.buildWhere(subClause, props);
        }
        sqlCond += ")";
        cs.push(sqlCond);
        return true;
      }
      switch (condType) {
        case 'gt':
        sqlCond += ' > ';
        break;
        case 'gte':
        sqlCond += ' >= ';
        break;
        case 'lt':
        sqlCond += ' < ';
        break;
        case 'lte':
        sqlCond += ' <= ';
        break;
        case 'between':
        sqlCond += ' BETWEEN ';
        break;
        case 'inq':
        sqlCond += ' IN ';
        break;
        case 'nin':
        sqlCond += ' NOT IN ';
        break;
        case 'neq':
        sqlCond += ' != ';
        break;
      }
      sqlCond += (condType == 'inq' || condType == 'nin') ? '(' + val + ')' : val;
      cs.push(sqlCond);
    } else {
      cs.push(keyEscaped + ' = ' + val);
    }
  });
  if (cs.length === 0) {
    return '';
  }
  return 'WHERE ' + cs.join(' AND ');
};

MsSQL.prototype.autoupdate = function (cb) {
     var self = this;
     var wait = 0;
     Object.keys(this._models).forEach(function (model) {
         wait += 1;
         self.query('SHOW FIELDS FROM ' + self.tableEscaped(model), function (err, fields) {
             self.query('SHOW INDEXES FROM ' + self.tableEscaped(model), function (err, indexes) {
                 if (!err && fields.length) {
                     self.alterTable(model, fields, indexes, done);
                 } else {
                     self.createTable(model, done);
                 }
             });
         });
     });

     function done(err) {
         if (err) {
             console.log(err);
         }
         if (--wait === 0 && cb) {
             cb();
         }
     }
};

MsSQL.prototype.isActual = function (cb) {
     var ok = false;
     var self = this;
     var wait = 0;
     Object.keys(this._models).forEach(function (model) {
         wait += 1;
         self.query("SELECT * FROM INFORMATION_SCHEMA.Columns WHERE TABLE_NAME = '" + model + "';", function (err, fields) {
//             self.query('SHOW INDEXES FROM [' + model + '];', function (err, indexes) {
                 self.alterTable(model, fields, [], done, true);
//             });
         });
     });

     function done(err, needAlter) {
         if (err) {
             console.log(err);
         }
         ok = ok || needAlter;
         if (--wait === 0 && cb) {
             cb(null, !ok);
         }
     }
};


//not working yet
MsSQL.prototype.alterTable = function (model, actualFields, actualIndexes, done, checkOnly) {
  var self = this;
  var m = this._models[model];
  var propNames = Object.keys(m.properties).filter(function (name) {
      return !!m.properties[name];
  });
  var indexNames = m.settings.indexes ? Object.keys(m.settings.indexes).filter(function (name) {
      return !!m.settings.indexes[name];
  }) : [];
  var sql = [];
  var ai = {};

  if (actualIndexes) {
      actualIndexes.forEach(function (i) {
          var name = i.Key_name;
          if (!ai[name]) {
              ai[name] = {
                  info: i,
                  columns: []
              };
          }
          ai[name].columns[i.Seq_in_index - 1] = i.Column_name;
      });
  }
  var aiNames = Object.keys(ai);

  // change/add new fields
  propNames.forEach(function (propName) {
      if (propName === 'id') return;
      var found;
      actualFields.forEach(function (f) {
          if (f.Field === propName) {
              found = f;
          }
      });

      if (found) {
          actualize(propName, found);
      } else {
          sql.push('ADD COLUMN `' + propName + '` ' + self.propertySettingsSQL(model, propName));
      }
  });

  // drop columns
  actualFields.forEach(function (f) {
      var notFound = !~propNames.indexOf(f.Field);
      if (f.Field === 'id') return;
      if (notFound || !m.properties[f.Field]) {
          sql.push('DROP COLUMN `' + f.Field + '`');
      }
  });

  // remove indexes
  aiNames.forEach(function (indexName) {
      if (indexName === 'id' || indexName === 'PRIMARY') return;
      if (indexNames.indexOf(indexName) === -1 && !m.properties[indexName] || m.properties[indexName] && !m.properties[indexName].index) {
          sql.push('DROP INDEX `' + indexName + '`');
      } else {
          // first: check single (only type and kind)
          if (m.properties[indexName] && !m.properties[indexName].index) {
              // TODO
              return;
          }
          // second: check multiple indexes
          var orderMatched = true;
          if (indexNames.indexOf(indexName) !== -1) {
              m.settings.indexes[indexName].columns.split(/,\s*/).forEach(function (columnName, i) {
                  if (ai[indexName].columns[i] !== columnName) orderMatched = false;
              });
          }
          if (!orderMatched) {
              sql.push('DROP INDEX `' + indexName + '`');
              delete ai[indexName];
          }
      }
  });

  // add single-column indexes
  propNames.forEach(function (propName) {
    var i = m.properties[propName].index;
    if (!i) {
        return;
    }
    var found = ai[propName] && ai[propName].info;
    if (!found) {
      var type = '';
      var kind = '';
      if (i.type) {
        type = 'USING ' + i.type;
      }
      if (i.kind) {
        // kind = i.kind;
      }
      if (kind && type) {
        sql.push('ADD ' + kind + ' INDEX `' + propName + '` (`' + propName + '`) ' + type);
      } else {
        sql.push('ADD ' + kind + ' INDEX `' + propName + '` ' + type + ' (`' + propName + '`) ');
      }
    }
  });

  // add multi-column indexes
  indexNames.forEach(function (indexName) {
    var i = m.settings.indexes[indexName];
    var found = ai[indexName] && ai[indexName].info;
    if (!found) {
      var type = '';
      var kind = '';
      if (i.type) {
        type = 'USING ' + i.type;
      }
      if (i.kind) {
        kind = i.kind;
      }
      if (kind && type) {
        sql.push('ADD ' + kind + ' INDEX `' + indexName + '` (' + i.columns + ') ' + type);
      } else {
        sql.push('ADD ' + kind + ' INDEX ' + type + ' `' + indexName + '` (' + i.columns + ')');
      }
    }
  });

  if (sql.length) {
    var query = 'ALTER TABLE ' + self.tableEscaped(model) + ' ' + sql.join(',' + MsSQL.newline);
    if (checkOnly) {
      done(null, true, {statements: sql, query: query});
    } else {
      this.query(query, done);
    }
  } else {
    done();
  }

  function actualize(propName, oldSettings) {
    var newSettings = m.properties[propName];
    if (newSettings && changed(newSettings, oldSettings)) {
      sql.push('CHANGE COLUMN `' + propName + '` `' + propName + '` ' + self.propertySettingsSQL(model, propName));
    }
  }

  function changed(newSettings, oldSettings) {
    if (oldSettings.Null === 'YES' && (newSettings.allowNull === false || newSettings.null === false)) return true;
    if (oldSettings.Null === 'NO' && !(newSettings.allowNull === false || newSettings.null === false)) return true;
    if (oldSettings.Type.toUpperCase() !== datatype(newSettings)) return true;
    return false;
  }
};

MsSQL.prototype.propertiesSQL = function (model) {
  // debugger;
  var self = this;
  var objModel = this._models[model];
  var modelPKID = this._pkids[model];

  var sql = ["[" + modelPKID + "] [int] IDENTITY(1,1) NOT NULL"];
  Object.keys(this._models[model].properties).forEach(function (prop) {
    if (prop === modelPKID) {
     return;
    }
    sql.push("[" + prop + "] " + self.propertySettingsSQL(model, prop));
  });
  var joinedSql = sql.join("," + MsSQL.newline + "    ");
  var cmd = "PRIMARY KEY CLUSTERED" + MsSQL.newline + "(" + MsSQL.newline;
  cmd += "    [" + modelPKID + "] ASC" + MsSQL.newline;
  cmd += ")";
  if (!this.azure) {
    cmd += " WITH (PAD_INDEX  = OFF, STATISTICS_NORECOMPUTE  = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS  = ON, ALLOW_PAGE_LOCKS  = ON) ON [PRIMARY]";
  }

  joinedSql += "," + MsSQL.newline + cmd;

  return joinedSql;
};

MsSQL.prototype.singleIndexSettingsSQL = function (model, prop, add) {
  // Recycled from alterTable single indexes above, more or less.
  var tblName = this.tableEscaped(model);
  var i = this._models[model].properties[prop].index;
  var type = 'ASC';
  var kind = 'NONCLUSTERED';
  var unique = false;
  if (i.type) {
    type = i.type;
  }
  if (i.kind) {
    kind = i.kind;
  }
  if (i.unique) {
    unique = true;
  }
  var name = prop + "_" + kind + "_" + type + "_idx";
  if (i.name) {
    name = i.name;
  }
  this._idxNames[model].push[name];
  var cmd = "CREATE " + (unique ? "UNIQUE " : "") + kind + " INDEX [" + name + "] ON [dbo].[" + tblName + "]" + MsSQL.newline;
      cmd += "(" + MsSQL.newline;
      cmd += "    [" + prop + "] " + type + MsSQL.newline + ")";
      if (!this.azure) {
        cmd += " WITH (PAD_INDEX  = OFF, STATISTICS_NORECOMPUTE  = OFF, SORT_IN_TEMPDB = OFF, IGNORE_DUP_KEY = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS  = ON, ALLOW_PAGE_LOCKS  = ON) ON [PRIMARY]";
      }
      cmd += ";" + MsSQL.newline;
  return cmd;
};

MsSQL.prototype.indexSettingsSQL = function (model, prop) {
  // Recycled from alterTable multi-column indexes above, more or less.
  var tblName = this.tableEscaped(model);
  var i = this._models[model].settings.indexes[prop];
  var type = 'ASC';
  var kind = 'NONCLUSTERED';
  var unique = false;
  if (i.type) {
    type = i.type;
  }
  if (i.kind) {
    kind = i.kind;
  }
  if (i.unique) {
    unique = true;
  }
  var splitcolumns = i.columns.split(",");
  var columns = [];
  var name = "";
  splitcolumns.forEach(function(elem, ind) {
    var trimmed = elem.trim();
    name += trimmed + "_";
    trimmed = "[" + trimmed + "] " + type;
    columns.push(trimmed);
  });

  name += kind + "_" + type + "_idx"
  this._idxNames[model].push[name];

  var cmd = "CREATE " + (unique ? "UNIQUE " : "") + kind + " INDEX [" + name + "] ON [dbo].[" + tblName + "]" + MsSQL.newline;
      cmd += "(" + MsSQL.newline;
      cmd += columns.join("," + MsSQL.newline);
      if (!this.azure) {
        cmd += MsSQL.newline + ") WITH (PAD_INDEX  = OFF, STATISTICS_NORECOMPUTE  = OFF, SORT_IN_TEMPDB = OFF, IGNORE_DUP_KEY = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS  = ON, ALLOW_PAGE_LOCKS  = ON) ON [PRIMARY]";
      }
      cmd += ";" + MsSQL.newline;
  return cmd;
};

MsSQL.prototype.propertySettingsSQL = function (model, prop) {
  var p = this._models[model].properties[prop];
  return datatype(p) + ' ' +
  (p.allowNull === false || p['null'] === false ? 'NOT NULL' : 'NULL');
};

MsSQL.prototype.automigrate = function (cb) {
  var self = this;
  var wait = 0;
  Object.keys(this._models).forEach(function (model) {
    wait += 1;
    self.dropTable(model, function (err) {
      // console.log('drop', model);
      if (err) throw err;
      self.createTable(model, function (err) {
        // console.log('create', model);
        if (err) throw err;
        done();
      });
    });
  });
  if (wait === 0) cb();

  function done() {
    if (--wait === 0 && cb) {
        cb();
    }
  }
};

MsSQL.prototype.dropTable = function (model, cb) {
  var tblName = this.tableEscaped(model);
  var cmd ="IF EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[" + tblName + "]') AND type in (N'U'))";
  cmd += MsSQL.newline + "BEGIN" + MsSQL.newline;
  cmd += "    DROP TABLE [dbo].[" + tblName + "]";
  cmd += MsSQL.newline + "END";
  //console.log(cmd);
  this.command(cmd, cb);
};

MsSQL.prototype.createTable = function (model, cb) {
  var tblName = this.tableEscaped(model);
  var cmd = "SET ANSI_NULLS ON;" + MsSQL.newline + "SET QUOTED_IDENTIFIER ON;" + MsSQL.newline + "SET ANSI_PADDING ON;" + MsSQL.newline;
  cmd += "IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[" + tblName + "]') AND type in (N'U'))" + MsSQL.newline + "BEGIN" + MsSQL.newline;
  cmd += "CREATE TABLE [dbo].[" + this.tableEscaped(model) + "] (";
  cmd += MsSQL.newline + "    " + this.propertiesSQL(model) + MsSQL.newline;
  cmd += ")";
  if (!this.azure) {
    cmd += " ON [PRIMARY]";
  }
  cmd += MsSQL.newline + "END;" + MsSQL.newline;
  //console.log(cmd);
  cmd += this.createIndexes(model);
  this.command(cmd, cb);
};

MsSQL.prototype.createIndexes = function(model) {
  var self = this;
  var sql = [];
  // Declared in model index property indexes.
  Object.keys(this._models[model].properties).forEach(function (prop) {
    var i = self._models[model].properties[prop].index;
    if (i) {
      sql.push(self.singleIndexSettingsSQL(model, prop));
    }
  });

  // Settings might not have an indexes property.
  var dxs = this._models[model].settings.indexes;
  if(dxs) {
    Object.keys(this._models[model].settings.indexes).forEach(function(prop){
      sql.push(self.indexSettingsSQL(model, prop));
    });
  }

  return sql.join(MsSQL.newline);
}

function datatype(p) {
    var dt = '';
    switch (p.type.name) {
        default:
        case 'String':
        case 'JSON':
        dt = '[varchar](' + (p.limit || 255) + ')';
        break;
        case 'Text':
        dt = '[text]';
        break;
        case 'Number':
        dt = '[int]';
        break;
        case 'Date':
        dt = '[datetime]';
        break;
        case 'Boolean':
        dt = '[bit]';
        break;
        case 'Point':
        dt = '[float]';
        break;
    }
    return dt;
}
