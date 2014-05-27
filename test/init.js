module.exports = require('should');

var db = require("../db/dbconfig");
var schemaSettings = {
    host: db.server,
    database: db.db,
    username: db.user,
    password: db.pwd,
    options: db.options,
    azure: db.azure
};

var Schema = require('jugglingdb').Schema;

if (!('getSchema' in global)) {

    global.getSchema = function () {
        var schema = new Schema(require('../'), schemaSettings);
        schema.log = function (a) {
            console.log(a);
        };
        return schema;
    }

}

