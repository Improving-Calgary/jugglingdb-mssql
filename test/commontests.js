var jdb = require('jugglingdb'),
    Schema = jdb.Schema,
    commonTest = jdb.test,
    db = require("../db/dbconfig");

var adapter = require("../");
var schemaSettings = {
  host:db.server,
  database:db.db,
  username:db.user,
  password:db.pwd,
  options: db.options,
  azure: db.azure
};
var schema = new Schema(adapter, schemaSettings);

//run the tests exposed by jugglingdb
commonTest(module.exports, schema);

commonTest.it("should count posts", function(test) {
  test.expect(2);
  schema.models.Post.count({title:"Title A"}, function(err, cnt) {
    test.ifError(err);
    test.equal(cnt, 2);
    test.done();
  });
});

commonTest.it("should delete a post", function(test) {
  schema.models.Post.all({
    where:{
      "title":"Title Z"
    }
  }, function(err, posts) {
    test.ifError(err);
    test.equal(posts.length, 1);
    id = posts[0].id;
    posts[0].destroy(function(err) {
      test.ifError(err);
      schema.models.Post.find(id, function(err, post) {
        test.ifError(err);
        test.equal(post, null);
        test.done();
      });
    });
  });
});

commonTest.it("should delete all posts", function(test) {
  test.expect(3);
  schema.models.Post.destroyAll(function(err) {
    test.ifError(err);
    schema.models.Post.count(function(err, cnt){
      test.ifError(err);
      test.equal(cnt, 0);
      test.done();
    });
  });
});

//custom primary keys not quite working :(, hopefully 1602 will implement that functionality in jugglingdb soon.
commonTest.it("should support custom primary key", function(test) {
  test.expect(3);
  var AppliesTo = schema.define("AppliesTo", {
    AppliesToID: {
      type:Number,
      primaryKey:true
    },
    Title: {
      type:String,
      limit:100
    },
    Identifier: {
      type:String,
      limit:100
    },
    Editable: {
      type:Number
    }
  });

  schema.automigrate(function (err) {
    test.ifError(err);

    AppliesTo.create({Title:"custom key", Identifier:"ck", Editable:false}, function(err, data) {
      test.ifError(err);
      test.notStrictEqual(typeof data.AppliesToID, 'undefined');
      test.done();
    });
  });

});
