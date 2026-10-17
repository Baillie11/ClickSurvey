require("dotenv").config();
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createGzip } = require("zlib");
const { pipeline } = require("stream/promises");
async function backup() {
  if (!process.env.DB_NAME || !/^[a-zA-Z0-9_]+$/.test(process.env.DB_NAME))
    throw Error("Invalid DB_NAME");
  const dir = path.resolve(__dirname, "../backups");
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(
    dir,
    `${process.env.DB_NAME}-${new Date().toISOString().replace(/[:.]/g, "-")}.sql.gz`,
  );
  const child = spawn(
    process.env.MYSQLDUMP_PATH || "mariadb-dump",
    [
      "--host",
      process.env.DB_HOST || "127.0.0.1",
      "--port",
      process.env.DB_PORT || "3306",
      "--user",
      process.env.DB_USER,
      "--single-transaction",
      "--quick",
      "--skip-lock-tables",
      process.env.DB_NAME,
    ],
    {
      env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || "" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              "Database dump failed; verify database credentials and dump permissions",
            ),
          ),
    );
  });
  try {
    await Promise.all([
      pipeline(
        child.stdout,
        createGzip(),
        fs.createWriteStream(file, { flags: "wx", mode: 0o600 }),
      ),
      done,
    ]);
    console.log(`Backup saved: ${file}`);
  } catch (error) {
    child.kill();
    await fs.promises.unlink(file).catch(() => {});
    throw error;
  }
}
if (require.main === module)
  backup().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { backup };
