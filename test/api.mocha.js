/*jslint node: true */
/*global describe, before, beforeEach, it*/
'use strict';

var _ = require('lodash');
var expect = require('expect.js');
var async = require('async');
var superagentDefaults = require('superagent-defaults');

var request = superagentDefaults();

var conf = require('nconf');
conf.argv().env().file({file: __dirname + '../config.json'}).defaults();
conf.set('port','1337');

// Override normal ENV values with nconf ENV values (ENV values are used the same way without nconf)
// FIXME can't get nconf file above to load...
process.env.BASE_URL = conf.get("BASE_URL");
process.env.FACEBOOK_KEY = conf.get("FACEBOOK_KEY");
process.env.FACEBOOK_SECRET = conf.get("FACEBOOK_SECRET");
process.env.NODE_DB_URI = 'mongodb://localhost/habitrpg';

var User = require('../src/models/user').model;
var Group = require('../src/models/group').model;
var Challenge = require('../src/models/challenge').model;

var app = require('../src/server');
var shared = require('habitrpg-shared');

// ###### Helpers & Variables ######
var model, uuid, taskPath,
baseURL = 'http://localhost:3000/api/v2';

var expectCode = function (res, code) {
  if (code == 200)
    expect(res.body.err).to.be(undefined);
  expect(res.statusCode).to.be(code);
};

describe('API', function () {
  var user, _id, apiToken, username, password;

  var registerNewUser = function(cb, main) {
    if (main === undefined) main = true;

    var randomID = shared.uuid();
    if (main) {
      username = password = randomID;
    }

    request.post(baseURL + "/register")
    .set('Accept', 'application/json')
    .send({
      username: randomID,
      password: randomID,
      confirmPassword: randomID,
      email: randomID + "@gmail.com"
    })
    .end(function (res) {
      if (!main) return cb(null, res.body);

      _id = res.body._id;
      apiToken = res.body.apiToken;
      User.findOne({_id: _id,
                   apiToken: apiToken},
                   function (err, _user) {
                     expect(err).to.not.be.ok();
                     user = _user;
                     request
                     .set('Accept', 'application/json')
                     .set('X-API-User', _id)
                     .set('X-API-Key', apiToken);
                     cb(null, res.body);
                   });
    });
  };

  before(function (done) {
    require('../src/server'); // start the server
    // then wait for it to do it's thing. TODO make a cb-compatible export of server
    setTimeout(done, 2000);
  });

  describe('Without token or user id', function () {
    it('/api/v2/status', function (done) {
      request.get(baseURL + "/status")
      .set('Accept', 'application/json')
      .end(function (res) {
        expect(res.statusCode).to.be(200);
        expect(res.body.status).to.be('up');
        done();
      });
    });

    it('/api/v2/user', function (done) {
      request.get(baseURL + "/user")
      .set('Accept', 'application/json')
      .end(function (res) {
        expect(res.statusCode).to.be(401);
        expect(res.body.err).to.be('You must include a token and uid (user id) in your request');
        done();
      });
    });
  });

  describe('With token and user id', function () {
    var currentUser;

    before(function (done) {
      registerNewUser(done, true);
    });

    beforeEach(function (done) {
      User.findById(_id, function (err, _user) {
        currentUser = _user;
        done();
      });
    });

    /**
     * GROUPS
     */
    describe('Groups', function () {
      var group;

      before(function (done) {
        request.post(baseURL + "/groups")
        .send({name:"TestGroup", type:"party"})
        .end(function (res) {
          expectCode(res, 200);
          group = res.body;
          expect(group.members.length).to.be(1);
          expect(group.leader).to.be(user._id);
          done();
          });
        });

      describe('Challenges', function () {
        var challenge, updateTodo;

        it('Creates a challenge', function (done) {
          request.post(baseURL + "/challenges")
          .send({
            group: group._id,
            dailys: [{type:'daily', text:'Challenge Daily'}],
            todos: [{type:'todo', text:'Challenge Todo', notes:'Challenge Notes'}],
            rewards: [],
            habits: [],
            official: true
          })
          .end(function (res) {
            expectCode(res, 200);
            async.parallel([
              function (cb) { User.findById(_id, cb); },
              function (cb) { Challenge.findById(res.body._id, cb); },
              ], function (err, results) {
              var _user = results[0];
              challenge = results[1];
              expect(_user.dailys[_user.dailys.length-1].text).to.be('Challenge Daily');
              updateTodo = _user.todos[_user.todos.length-1];
              expect(updateTodo.text).to.be('Challenge Todo');
              expect(challenge.official).to.be(false);
              done();
              });
            });
        });

        it('User updates challenge notes', function (done) {
          updateTodo.notes = "User overriden notes";
          request.put(baseURL + "/user/tasks/" + updateTodo.id)
          .send(updateTodo)
          .end(function (res) {
            done(); // we'll do the check down below
          });
        });

        it('Change challenge daily', function (done) {
          challenge.dailys[0].text = 'Updated Daily';
          challenge.todos[0].notes = 'Challenge Updated Todo Notes';
          request.post(baseURL + "/challenges/" + challenge._id)
          .send(challenge)
          .end(function (res) {
            setTimeout(function () {
              User.findById(_id, function (err,_user) {
                expectCode(res, 200);
                expect(_user.dailys[_user.dailys.length-1].text).to.be('Updated Daily');
                expect(res.body.todos[0].notes).to.be('Challenge Updated Todo Notes');
                expect(_user.todos[_user.todos.length-1].notes).to.be('User overriden notes');
                currentUser = _user;
                done();
              });
            }, 500); // we have to wait a while for users' tasks to be updated, called async on server
          });
        });

        it('Shows user notes on challenge page', function (done) {
          request.get(baseURL + "/challenges/" + challenge._id + "/member/" + _id)
          .end(function (res) {
            expect(res.body.todos[res.body.todos.length-1].notes).to.be('User overriden notes');
            done();
          });
        });

        it('Complete To-Dos', function (done) {
          var u = currentUser;
          request.post(baseURL + "/user/tasks/" + u.todos[0].id + "/up").end(function (res) {
            request.post(baseURL + "/user/tasks/" + u.todos[1].id + "/up").end(function (res) {
              request.post(baseURL + "/user/tasks/").send({type:'todo'}).end(function (res) {
                request.post(baseURL + "/user/tasks/clear-completed").end(function (res) {
                  expect(_.size(res.body)).to.be(2);
                  done();
                });
              });
            });
          });
        });

        it('Admin creates a challenge', function (done) {
          User.findByIdAndUpdate(_id, {$set:{'contributor.admin':true}}, function (err,_user) {
            expect(err).to.not.be.ok();

            async.parallel([
              function (cb) {
              request.post(baseURL + "/challenges")
              .send({group:group._id, dailys: [], todos: [], rewards: [], habits: [], official: false}).end(function (res) {
                expect(res.body.official).to.be(false);
                cb();
              });
            },
            function (cb) {
              request.post(baseURL + "/challenges")
              .send({group:group._id, dailys: [], todos: [], rewards: [], habits: [], official: true}).end(function (res) {
                expect(res.body.official).to.be(true);
                cb();
              });
            }], done);
          });
        });
      });

      describe('Quests', function () {
        var party,
            participating = [],
            notParticipating = [];

        it('Invites some members', function (done) {
          async.waterfall([

            // Register new users
            function (cb) {
              async.parallel([
                function (cb2) { registerNewUser(cb2,false); },
                function (cb2) { registerNewUser(cb2,false); },
                function (cb2) { registerNewUser(cb2,false); }
              ], cb);
            },

            // Send them invitations
            function (_party, cb) {
              party = _party;
              var inviteURL = baseURL + "/groups/" + group._id + "/invite?uuid=";
              async.parallel([
                function (cb2) { request.post(inviteURL + party[0]._id).end(cb2); },
                function (cb2) { request.post(inviteURL + party[1]._id).end(cb2); },
                function (cb2) { request.post(inviteURL + party[2]._id).end(cb2); }
              ], cb);
            },

            // Accept / Reject
            function (results, cb) {
              // series since they'll be modifying the same group record
              async.series(_.reduce(party, function (m,v,i) {
                m.push(function (cb2) {
                  request.post("#{baseURL}/groups/#{group._id}/join")
                  .set('X-API-User', party[i]._id)
                  .set('X-API-Key', party[i].apiToken)
                  .end(cb2);
                });
                return m;
              }, []), cb);
            },

            // Make sure the invites stuck
            function (whatever, cb) {
              Group.findById(group._id, function (err, g) {
                expect(g.members.length).to.be(4);
                cb();
              });
            }

          ], function (err, results) {
            expect(err).to.be.ok();
            done();
          });
        });

        it('Starts a quest', function (done) {
          async.waterfall([
            function (cb) {
              request.post(baseURL + "/groups/" + group._id + "/questAccept?key=evilsanta")
              .end(function (res) {
                expectCode(res, 401);
                User.findByIdAndUpdate(_id, {$set: {'items.quests.evilsanta':1}}, cb);
              });
            },
            function (_user,cb) {
              request.post(baseURL + "/groups/" + group._id + "/questAccept?key=evilsanta")
              .end(function (res) {
                expectCode(res, 200);
                Group.findById(group._id, cb);
              });
            },
            function (_group,cb) {
              group = _group; //refresh local group
              expect(group.quest.key).to.be('evilsanta');

              async.series(_.reduce(party, function (m,v,i) {
                m.push(function (cb2) {
                  request.post(baseURL + "/groups/" + group._id + "/questAccept")
                  .set('X-API-User', party[i]._id)
                  .set('X-API-Key', party[i].apiToken)
                  .end(function () { cb2(); });
                });
                return m;
              }, []), cb);
            }], done);
        });

        it("Doesn't include people who aren't participating");
      });

    });
  });
});
