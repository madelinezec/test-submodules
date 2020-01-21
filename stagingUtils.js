const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const fs = require('fs');
const { MongoClient } = require('mongodb');

module.exports = {
  insertJob(payloadObj, jobTitle, jobUserName, jobUserEmail) {
    const dbName = process.env.DB_NAME;
    const collName = process.env.COL_NAME;
    const username = process.env.USERNAME;
    const secret = process.env.SECRET;
    // create the new job document
    const newJob = {
      title: jobTitle,
      user: jobUserName,
      email: jobUserEmail,
      status: 'inQueue',
      createdTime: new Date(),
      startTime: null,
      endTime: null,
      priority: 1,
      numFailures: 0,
      failures: [],
      result: null,
      payload: payloadObj,
      logs: {},
    };

    // we are looking for jobs in the queue with the same payload
    // that have not yet started (startTime == null)
    const filterDoc = { payload: payloadObj, status: { $in: ['inProgress', 'inQueue'] } };
    const updateDoc = { $setOnInsert: newJob };

    const uri = `mongodb+srv://${username}:${secret}@cluster0-ylwlz.mongodb.net/test?retryWrites=true&w=majority`;
    const client = new MongoClient(uri, { useUnifiedTopology: true, useNewUrlParser: true });
    client.connect((err) => {
      if (err) {
        console.error('error connecting to Mongo');
        return err;
      }
      const collection = client.db(dbName).collection(collName);

      collection.updateOne(filterDoc, updateDoc, { upsert: true }).then(
        (result) => {
          if (result.upsertedId) {
            console.log(`You successfully enqued a staging job to docs autobuilder. This is the record id: ${result.upsertedId}`);
            return true;
          }
          console.log('This job already exists ');
          return 'Already Existed';
        },
        (error) => {
          console.error(`There was an error enqueing a staging job to docs autobuilder. Here is the error: ${error}`);
          return error;
        },
      );
      client.close();
    });
  },

  createPayload(
    repoNameArg,
    upstreamBranchName,
    repoOwnerArg,
    urlArg,
    patchArg,
    buildSizeArg,
    lastCommit
  ) {
    const payload = {
      jobType: 'githubPush',
      source: 'github',
      action: 'push',
      repoName: repoNameArg,
      branchName: upstreamBranchName,
      isFork: true,
      private: false,
      isXlarge: false,
      repoOwner: repoOwnerArg,
      url: urlArg,
      newHead: lastCommit,
      patch: patchArg,
    };

    return payload;
  },

  async getBranchName() {
    return new Promise((resolve) => {
      exec('git rev-parse --abbrev-ref HEAD')
        .then((result) => {
          resolve(result.stdout.replace('\n', ''));
        })
        .catch(console.error);
    });
  },

  // extract repo name from url
  getRepoName(url) {
    if (url === undefined) {
      console.error('getRepoName error: repository url is undefined');
    }
    let repoName = url.split('/');
    repoName = repoName[repoName.length - 1];
    repoName = repoName.replace('.git', '');
    repoName = repoName.replace('\n', '');
    return repoName;
  },

  // delete patch file
  async deletePatchFile() {
    return new Promise((resolve, reject) => {
      exec('rm myPatch.patch')
        .then(() => {
          resolve('successfully removed patch file');
        })
        .catch((error) => {
          console.error(`exec error deleting patch file: ${error}`);
          reject(error);
        });
    });
  },

  async getRepoInfo() {
    return new Promise((resolve, reject) => {
      exec('git config --get remote.origin.url')
        .then((stdout) => {
          const repoUrl = stdout.replace('\n', '');
          resolve(repoUrl);
        })
        .catch((error) => {
          console.error(`exec error: ${error}`);
          reject(error);
        });
    });
  },

  async getGitEmail() {
    return new Promise((resolve, reject) => {
      exec('git config --global user.email')
        .then((stdout) => {
          resolve(stdout.replace('\n', ''));
        })
        .catch((error) => {
          console.error(`exec error: ${error}`);
          reject(error);
        });
    });
  },

  async getGitUser() {
    return new Promise((resolve, reject) => {
      exec('git config --global user.name')
        .then((stdout) => {
          resolve(stdout.replace('\n', ''));
        })
        .catch((error) => {
          console.error(`exec error: ${error}`);
          reject(error);
        });
    });
  },

  async getGitCommits() {
    const stdout = await exec('git cherry');
    const cleanedup = stdout.replace(/\+ /g, '');
    const commitarray = cleanedup.split(/\r\n|\r|\n/);
    commitarray.pop(); // remove the last, dummy element that results from splitting on newline
    if (commitarray.length === 0) {
      console.error(
        'You have tried to create a staging job from local commits but you have no committed work. Please make commits and then try again'
      );
      process.exit();
    }
    if (commitarray.length === 1) {
      const firstCommit = commitarray[0];
      const lastCommit = null;
      return { firstCommit, lastCommit };
    }
    const firstCommit = commitarray[0];
    const lastCommit = commitarray[commitarray.length - 1];
    return { firstCommit, lastCommit };
  },

  getUpstreamName(upstream) {
    const upstreamInd = upstream.indexOf('origin/');
    if (upstreamInd === -1) {
      return upstream;
    }
    return 'master';
  },

  async checkUpstreamConfiguration(branchName) {

    try {
      const stdout = await exec(
        `git rev-parse --abbrev-ref --symbolic-full-name ${branchName}@{upstream}`
      );
      return stdout;
    } catch (error) {
      if (error.code === 128) {
        const errormsg = "You have not set an upstream for your local branch. Please do so with this command: \
          \n\n \
          git branch -u <upstream-branch-name>\
          \n\n";
        console.error(errormsg);
        return errormsg;
      }
      console.error(error);
      return error;
    }
  },

  async doesRemoteHaveLocalBranch(branchName) {
    try {
      await exec(`git diff ${branchName} remotes/origin/${branchName}`);
      return true;
    } catch (error) {
      if (error.code === 128) {
        // we dont want to cancel the program
        return false;
      }
      console.error(error);
      return false;
    }
  },

  async getGitPatchFromLocal(upstreamBranchName) {
    return new Promise((resolve, reject) => {
      exec(`git diff ${upstreamBranchName} --ignore-submodules > myPatch.patch`)
        .then(() => {
          fs.readFile('myPatch.patch', 'utf8')
            .then((data) => {
              console.log(data);
              resolve(data);
            })
            .catch((error) => {
              console.log('error reading patch file: ', error);
              reject(error);
            });
        })
        .catch((error) => {
          console.error('error generating patch: ', error);
          reject(error);
        });
    });
  },
  async getGitPatchFromCommits(firstCommit, lastCommit) {
    // need to delete patch file?
    return new Promise((resolve, reject) => {
      if (lastCommit === null) {
        const patchCommand = 'git show HEAD > myPatch.patch';
        exec(patchCommand)
          .then(() => {
            fs.readFile('myPatch.patch', 'utf8')
              .then((data) => {
                resolve(data);
              })
              .catch((error) => {
                console.log('error reading patch file', error);
                reject(error);
              });
          })
          .catch((error) => {
            console.error('error generating patch: ', error);
            reject(error);
          });
      } else {
        const patchCommand = `git diff ${firstCommit}^...${lastCommit} > myPatch.patch`;
        exec(patchCommand)
          .then(() => {
            fs.readFile('myPatch.patch', 'utf8')
              .then((data) => {
                resolve(data);
              })
              .catch((error) => {
                console.log('error reading patch file', error);
                reject(error);
              });
          })
          .catch((error) => {
            console.error('error generating patch: ', error);
            reject(error);
          });
      }
    });
  },

  validateConfiguration() {
    const missingConfigs = [];

    if (process.env.DB_NAME === undefined || process.env.DB_NAME === '') {
      missingConfigs.push('DB_NAME');
    }
    if (process.env.COL_NAME === undefined || process.env.COL_NAME === '') {
      missingConfigs.push('COL_NAME');
    }
    if (process.env.USERNAME === undefined || process.env.USERNAME === '') {
      missingConfigs.push('USERNAME');
    }
    if (process.env.SECRET === undefined || process.env.SECRET === '') {
      missingConfigs.push('SECRET');
    }
    if (missingConfigs.length !== 0) {
      console.error(
        `The ~/.config/.snootyenv file is found but does not contain the following required fields: ${missingConfigs.toString()}`
      );
      process.exit();
    }
  },
};
