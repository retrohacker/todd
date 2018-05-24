// Description:
//   Generates help commands for Hubot.
//
// Commands:
//   hubot merge <pull_request> - Merge a pull request into the next branch (must use the PR number).
//   hubot prepare next - Prepare the next branch for being released
//
// Configuration:
//   GITHUB_TOKEN - The API token to use for accessing the GitHub API

const octokit = require('@octokit/rest')();
const async = require('async');
const exec = require('child_process').exec;
const uuid = require('uuid/v4');
const rimraf = require('rimraf');
const fs = require('fs');

const REPO_OWNER = process.env["GITHUB_REPO_OWNER"];
const REPO_NAME = process.env["GITHUB_REPO"];
const SLACK_CHANNEL = process.env["SLACK_CHANNEL"];
const TOKEN = process.env["GITHUB_TOKEN"];

octokit.authenticate({
    type: "token",
    token: TOKEN,
});

function fail(res, news, err) {
  let message = err;
  if(err.message && typeof err.message === "string") {
    try {
      message = JSON.parse(err.message).message
    } catch(e) {}
  }
  res.send(
    `I've got good news and bad news. The bad news is that there is no good ` +
    `news. The other bad news is ${news}. GitHub said: ${message}`
  );
}

function prepare_next(res) {
  res.send("I'm going to prepare next for a release! YAY I'm helping!");
  let id;
  let clone_dir;
  let frozen;
  let canary;
  async.waterfall([
    // First ensure the pull request is open
    function (cb) {
      octokit.pullRequests.getAll({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        state: "open",
        head: "next",
        per_page: 100,
      }, function (err, result) {
        if(err) {
          fail(res, "I was unable to search existing PRs", err);
          return cb(err);
        }
        if(result.data.length == 0) {
          return cb();
        }
        if(result.data.length > 1) {
          fail(
            res,
            "I found more than one open PR for next, I'm not sure what to do",
            result.data
          );
          return cb(new Error());
        }
        id = result.data[0].number;
        return cb();
      })
    },
    // If we don't already have a PR, open one
    function (cb) {
      if(id) { // Only do this if a PR doesn't already exist
        return cb();
      }
      octokit.pullRequests.create({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        title: "next",
        head: "next",
        base: "master",
        maintainer_can_modify: true,
      }, function (err, result) {
        if(err) {
          fail(res, "I was unable to open a PR for next", err);
        }
        id = result.data.number;
        return cb(err);
      });
    },
    // Clone the github repo
    function (cb) {
      clone_dir = uuid();
      let cmd =
        `git clone git@github.com:${REPO_OWNER}/${REPO_NAME} ${clone_dir}`;
      exec(cmd, function(err, stdout, stderr) {
        if(err) {
          fail(res, "I wasn't able to clone the github repo", err);
        }
        return cb(err);
      });
    },
    // Checkout the next branch
    function (cb) {
      let cmd = `cd ${clone_dir} && git checkout next`;
      exec(cmd, function(err, stdout, stderr) {
        if(err) {
          fail(res, "I wasn't able to checkout the next branch", err);
        }
        return cb(err);
      });
    },
    // Make sure next is sitting on top of the latest master
    function (cb) {
      let cmd =
        `cd ${clone_dir} && ` +
        `git rebase master && ` +
        `git push origin next --force`;
      exec(cmd, function(err, stdout, stderr) {
        if(err) {
          fail(res, "I wasn't able to rebase next branch onto master", err);
        }
        return cb(err);
      });
    },
    // Generate the changelog
    function (cb) {
      let cmd =
        `cd ${clone_dir} && ` +
        `make changelog && ` +
        `git add CHANGES.md && ` +
        `git commit -m 'chore: make changelog' && ` +
        `git push origin next && ` +
        `make changelog && ` +
        `git reset $(git log --format="%H" -n 2 | tail -n 1) && ` +
        `git add CHANGES.md && ` +
        `git commit -m 'chore: make changelog' && ` +
        `git push origin next --force`;
      exec(cmd, function(err, stdout, stderr) {
        if(err) {
          fail(res, "I wasn't able to generate the changelog", err);
        }
        return cb(err);
      });
    },
    // Set labels on issue
    function (cb) {
      octokit.issues.addLabels({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        number: id,
        labels: ["Frozen", "Needs Canary"],
      }, function (err, result) {
        if(err) {
          fail(res, "I was unable to set labels on the PR", err);
        }
        return cb(err);
      });
    }
  ], function(e) {
    if(clone_dir) {
      // Cleanup the git clone
      rimraf(clone_dir, function() {});
    }
    if(e) { return; }
    res.send(`Todd did good! Next branch (PR #${id}) is ready to be released.`);
  });
}

// Make sure todd has an ssh key and that it is on GitHub. We can't block
// startup to do this, but we can at least report out to slack that we are doing
// stuff and leave it to users not to cause race conditions.
function setup_github(robot) {
  robot.messageRoom(SLACK_CHANNEL, "Robot todd is starting up...");
  let key;
  async.waterfall([
    // Generate an ssh key
    function (cb) {
      exec('ssh-keygen -b 2048 -t rsa -f ~/.ssh/id_rsa -q -N ""', function(e) {
        if(e) {
          robot.messageRoom(SLACK_CHANNEL, "couldn't generate ssh key...");
        }
        return cb(e);
      });
    },
    // Read key
    function (cb) {
      fs.readFile('/root/.ssh/id_rsa.pub', 'utf8', function(e, str) {
        if(e) {
          robot.messageRoom(SLACK_CHANNEL, `couldn't read key: ${e}`);
        }
        key = str;
        return cb(e);
      });
    },
    // Add ssh key
    function (cb) {
      octokit.users.createKey({
        "title": uuid(),
        "key": key,
      }, function(e) {
        if(e) {
          let err = JSON.stringify(e);
          try {
            err = JSON.parse(err).message;
          } catch(e) {}
          robot.messageRoom(SLACK_CHANNEL, `couldn't add key ${err}`);
        }
        return cb(e);
      });
    }
  ], function(e) {
    let msg = "I'm awake!";
    if(e) {
      msg = "I was unable to add my ssh key to GitHub, I won't be able " +
        "to work with any code...";
    }
    robot.messageRoom(SLACK_CHANNEL, msg);
  });
}

module.exports = function(robot) {
  setup_github(robot);
  robot.respond(/merge #?([0-9]*)$/i, function (res) {
    res.send(`I'm going to merge branch #${res.match[1]}! YAY I'm helping!`);
    async.waterfall([
      // Ensure we are merging into the next branch
      function (cb) {
        octokit.pullRequests.get({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          number: res.match[1]
        }, function (err, result) {
          if(err) {
            fail(res, "I wasn't able to get any information on that PR", err);
            return cb(err);
          }
          if(!result || !result.data || !result.data.base) {
            fail(res, "I wasn't able to get the base of that PR",
              JSON.stringify(result)
            );
            return cb(new Error());
          }
          if(result.data.base.ref !== 'next') {
            fail(res, "I can't merge PRs into anything but the next branch",
              `branch is ${result.data.base.ref}`
            );
            return cb(new Error());
          }
          return cb();
        });
      },
      // Squash and merge
      function (cb) {
        octokit.pullRequests.merge({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          number: res.match[1],
          merge_method: "squash",
        }, function(err, result) {
          if(err) {
            fail(res, "the merge failed", err);
            return cb(err);
          }
          return cb();
        });
      },
      // Comment on the repo
      function (cb) {
        octokit.issues.createComment({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          number: res.match[1],
          body: "Todd is helping!"
        }, function (err, result) {
          return cb();
        });
      }
    ], function(e) {
      if(e) { return; }
      res.send("Todd did good! Your PR was merged into next!");
    });
  });

  robot.respond(/prepare next$/i, prepare_next);
};
