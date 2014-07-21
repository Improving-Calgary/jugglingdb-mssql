var should = require('should');
var db, User;


describe('querying using IN clause', function () {

  before(function(done) {
      db = getSchema();

      User = db.define('User', {
          name: {type: String, sort: true, limit: 100},
          email: {type: String, index: true, limit: 100},
          role: {type: String, index: true, limit: 100},
          order: {type: Number, index: true, sort: true, limit: 100}
      });

      db.automigrate(done);

  });

  before(seed);

  it('should query by array', function(done) {
      User.all({ where: {name: {inq: ['John Lennon', 'Paul McCartney'] } } }, function(err, users) {
          should.exists(users);
          should.not.exists(err);
          users.should.have.lengthOf(2);
          done();
      });
  });

  it('should query empty array', function (done) {
    User.all({ where: {name: {inq: [] } } }, function(err, users) {
        should.exists(users);
        should.not.exists(err);
        users.should.have.lengthOf(0);
        done();
    });

  });

});


function seed(done) {
    var count = 0;
    var beatles = [
        {
            name: 'John Lennon',
            mail: 'john@b3atl3s.co.uk',
            role: 'lead',
            order: 2
        }, {
            name: 'Paul McCartney',
            mail: 'paul@b3atl3s.co.uk',
            role: 'lead',
            order: 1
        },
        {name: 'George Harrison', order: 5},
        {name: 'Ringo Starr', order: 6},
        {name: 'Pete Best', order: 4},
        {name: 'Stuart Sutcliffe', order: 3}
    ];
    User.destroyAll(function() {
        beatles.forEach(function(beatle) {
            User.create(beatle, ok);
        });
    });

    function ok() {
        if (++count === beatles.length) {
            done();
        }
    }
}
