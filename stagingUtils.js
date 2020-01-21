const { promisify } = require("util");
const exec = promisify(require("child_process").exec);
const fs = require("fs");
const { MongoClient } = require("mongodb");

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
      status: "inQueue",
      createdTime: new Date(),
      startTime: null,
      endTime: null,
      priority: 1,
      numFailures: 0,
      failures: [],
      result: null,
      payload: payloadObj,
      logs: {}
    };

    // we are looking for jobs in the queue with the same payload
    // that have not yet started (startTime == null)
    const filterDoc = { payload: payloadObj, status: ["inProgress", "inQueue"] }
    const updateDoc = { $setOnInsert: newJob };

    //const filterDoc = {$or: [ { payload: payloadObj, status: "inQueue" }, { payload: payloadObj, status: "inProgress" }]};
    const uri = `mongodb+srv://${username}:${secret}@cluster0-ylwlz.mongodb.net/test?retryWrites=true&w=majority`;
    const client = new MongoClient(uri, { useUnifiedTopology: true, useNewUrlParser: true });
    client.connect(err => {
      if (err) {
        console.error("error connecting to Mongo");
        return err;
      }
      const collection = client.db(dbName).collection(collName);
      collection.updateOne(filterDoc, updateDoc, { upsert: true }).then(
        result => {
          if (result.upsertedId) {
            console.log(
              "You successfully enqued a staging job to docs autobuilder. This is the record id: ",
              result.upsertedId
            );
            return true;
          }
          console.log("This job already exists ");
          return "Already Existed";
        },
        error => {
          console.error(
            "There was an error enqueing a staging job to docs autobuilder. Here is the error: ",
            error
          );
          return error;
        }
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
      jobType: "githubPush",
      source: "github",
      action: "push",
      repoName: repoNameArg,
      branchName: upstreamBranchName,
      isFork: true,
      private: false,
      isXlarge: false,
      repoOwner: repoOwnerArg,
      url: urlArg,
      newHead: lastCommit,
      patch: patchArg
    };

    return payload;
  },

  async getBranchName() {
    return new Promise((resolve, reject) => {
      exec("git rev-parse --abbrev-ref HEAD", (error, stdout) => {
        if (error !== null) {
          console.error(`exec error: ${error}`);
          reject(error);
        }
        resolve(stdout.replace("\n", ""));
      });
    });
  },

  // extract repo name from url
  getRepoName(url) {
    if (url === undefined){
      console.error(`getRepoName error: repository url is undefined`)
    }
    let repoName = url.split("/");
    repoName = repoName[repoName.length - 1];
    repoName = repoName.replace(".git", "");
    repoName = repoName.replace("\n", "");
    return repoName;
  },

  // delete patch file
  async deletePatchFile() {
    return new Promise((resolve, reject) => {
      exec("rm myPatch.patch", error => {
        if (error !== null) {
          console.error("exec error deleting patch file: ", error);
          reject(error);
        }
        resolve("successfully removed patch file");
      });
    });
  },

  async getRepoInfo() {
    return new Promise((resolve, reject) => {
      exec("git config --get remote.origin.url", (error, stdout) => {
        if (error !== null) {
          console.error(`exec error: ${error}`);
          reject(error);
        }

        const repoUrl = stdout.replace("\n", "");
        resolve(repoUrl);
      });
    });
  },

  async getGitEmail() {
    return new Promise((resolve, reject) => {
      exec("git config --global user.email", (error, stdout) => {
        if (error !== null) {
          console.error(`exec error: ${error}`);
          reject(error);
        } else {
          resolve(stdout.replace("\n", ""));
        }
      });
    });
  },

  async getGitUser() {
    return new Promise((resolve, reject) => {
      exec("git config --global user.name", (error, stdout) => {
        if (error !== null) {
          console.error(`exec error: ${error}`);
          reject(error);
        } else {
          resolve(stdout.replace("\n", ""));
        }
      });
    });
  },

  async getGitCommits() {
    try {
      const { stdout, stderr } = await exec("git cherry");
      const cleanedup = stdout.replace(/\+ /g, "");
      const commitarray = cleanedup.split(/\r\n|\r|\n/);
      commitarray.pop(); // remove the last, dummy element that results from splitting on newline
      if (commitarray.length === 0) {
        console.log(
          "You have tried to create a staging job from local commits but you have no committed work. Please make commits and then try again"
        );
        process.exit();
      }
      if (commitarray.length === 1) {
        const firstCommit = commitarray[0];
        const lastCommit = null;
        return { firstCommit, lastCommit };
      } else {
        const firstCommit = commitarray[0];
        const lastCommit = commitarray[commitarray.length - 1];
        return { firstCommit, lastCommit }
      }
    } catch (error) {
      throw error;
    }

  },

  getUpstreamName(upstream) {
    const upstreamInd = upstream.indexOf("origin/");
    if (upstreamInd === -1) {
      return upstream;
    } else {
      const upstream = "master";
      return upstream;
    }
  },

  async checkUpstreamConfiguration(branchName) {

    try {
      const { stdout, stderr } = await exec(
        `git rev-parse --abbrev-ref --symbolic-full-name ${branchName}@{upstream}`
      );

      return stdout;
    } catch (error) {
      if (error.code === 128) {
        const errormsg =
          "You have not set an upstream for your local branch. Please do so with this command: \
          \n\n \
          git branch -u <upstream-branch-name>\
          \n\n";
        throw errormsg;
      } else {
        throw error;
      }
    }
  },

  async doesRemoteHaveLocalBranch(branchName) {
    try {
      const { stdout, stderr } = await exec(
        `git diff ${branchName} remotes/origin/${branchName}`
      );

      return true;
    } catch (error) {
      if (error.code === 128) {
        return false;
        //we dont want to cancel the program
      } else {
        throw error;
      }
    }
  },

  async getGitPatchFromLocal(upstreamBranchName) {

    return new Promise((resolve, reject) => {
      exec(
        `git diff ${upstreamBranchName} --ignore-submodules > myPatch.patch`,
        error => {
          if (error !== null) {
            console.error("error generating patch: ", error);
            reject(error);
          } else {
            fs.readFile("myPatch.patch", "utf8", (err, data) => {
              if (err) {
                console.log("error reading patch file: ", err);
                reject(err);
              }
              resolve(data);
            });
          }
        }
      );
    });
  },
  async getGitPatchFromCommits(firstCommit, lastCommit) {
    //need to delete patch file?
    return new Promise((resolve, reject) => {
      if (lastCommit === null) {
        const patchCommand = "git show HEAD > myPatch.patch";
        exec(patchCommand, error => {
          if (error !== null) {
            console.error("error generating patch: ", error);
            reject(error);
          } else {
            fs.readFile("myPatch.patch", "utf8", (err, data) => {
              if (err) {
                console.log("error reading patch file", err);
                reject(err);
              }
              resolve(data);
            });
          }
        });
      } else {
        const patchCommand = `git diff ${firstCommit}^...${lastCommit} > myPatch.patch`;
        exec(patchCommand, error => {
          if (error !== null) {
            console.error("error generating patch: ", error);
            reject(error);
          } else {
            fs.readFile("myPatch.patch", "utf8", (err, data) => {
              if (err) {
                console.log("error reading patch file ", err);
                reject(err);
              }
              resolve(data);
            });
          }
        });
      }
    });
  },

  validateConfiguration() {
    const missingConfigs = [];

    if (process.env.DB_NAME === undefined || process.env.DB_NAME === "") {
      missingConfigs.push("DB_NAME");
    }
    if (process.env.COL_NAME === undefined || process.env.COL_NAME === "") {
      missingConfigs.push("COL_NAME");
    }
    if (process.env.USERNAME === undefined || process.env.USERNAME === "") {
      missingConfigs.push("USERNAME");
    }
    if (process.env.SECRET === undefined || process.env.SECRET === "") {
      missingConfigs.push("SECRET");
    }
    if (missingConfigs.length !== 0) {
      console.error(
        `The ~/.config/.snootyenv file is found but does not contain the following required fields: ${missingConfigs.toString()}`
      );
      process.exit();
    }
  }
};
