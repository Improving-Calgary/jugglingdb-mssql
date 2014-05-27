module.exports = require('should');

var Schema = require('jugglingdb').Schema;

if (!('getSchema' in global)) {
  global.getSchema = function() {
    var db = require("../db/dbconfig");
    var schemaSettings = {
        host: db.server,
        database: db.db,
        username: db.user,
        password: db.pwd,
        options: db.options,
        azure: db.azure
    };
    var db = new Schema(require('../'), schemaSettings);
    db.log = function (a) {
        console.log(a);
    };
    return db;
  }
}
