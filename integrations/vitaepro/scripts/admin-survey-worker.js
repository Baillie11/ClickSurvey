require("dotenv").config();
const { poolFromEnv } = require("../admin/db");
const { prepare, dispatch } = require("../admin/survey-worker");
const pool = poolFromEnv();
(async () => {
  console.log(await prepare(pool));
  console.log(await dispatch(pool));
})()
  .catch((e) => {
    console.error(e.code || "Survey worker failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
