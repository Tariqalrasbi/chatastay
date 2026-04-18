#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Restores the live SQLite DB from a backup .db file.
 *
 * Usage:
 *   npm run restore:db -- /absolute/or/relative/path/to/backup.db
 *   npm run restore:db -- ./backups/sqlite/chatastay-....db --pm2-offline-restore
 *
 * Legacy (still supported):
 *   node scripts/restore-sqlite.cjs --from=/path/to/backup.db --confirm-restore
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveSqliteMainDatabaseFile } = require("./lib/sqlite-path.cjs");

const root = path.resolve(__dirname, "..");

function parseArgs(argv) {
  let from = "";
  let confirmLegacy = false;
  let pm2OfflineRestore = false;
  let restartPm2Only = false;
  const positionals = [];

  for (const a of argv) {
    if (a.startsWith("--from=")) from = a.slice("--from=".length).trim();
    else if (a === "--confirm-restore") confirmLegacy = true;
    else if (a === "--pm2-offline-restore") pm2OfflineRestore = true;
    else if (a === "--restart-pm2") restartPm2Only = true;
    else if (!a.startsWith("-")) positionals.push(a);
  }

  if (!from && positionals.length) from = positionals[0];
  return { from, confirmLegacy, pm2OfflineRestore, restartPm2Only };
}

function removeWalShm(mainPath) {
  for (const s of [`${mainPath}-wal`, `${mainPath}-shm`]) {
    try {
      if (fs.existsSync(s)) fs.unlinkSync(s);
    } catch {
      /* ignore */
    }
  }
}

function runPm2(args) {
  const r = spawnSync("pm2", args, { cwd: root, env: process.env, encoding: "utf8", stdio: "inherit" });
  return r.status === 0;
}

function validateSqliteBackup(absFrom) {
  const st = fs.statSync(absFrom);
  if (!st.isFile() || st.size < 1) {
    console.error("[restore-sqlite] FAILED: backup is missing or empty:", absFrom);
    return false;
  }

  const fd = fs.openSync(absFrom, "r");
  try {
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    if (n < 16 || buf.toString("utf8", 0, 16) !== "SQLite format 3\u0000") {
      console.error("[restore-sqlite] FAILED: file does not look like a SQLite 3 database (missing header).");
      return false;
    }
  } finally {
    fs.closeSync(fd);
  }

  const sqlite3 = process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
  const hasSqlite3 = spawnSync(sqlite3, ["-version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).status === 0;
  if (!hasSqlite3) {
    console.warn("[restore-sqlite] WARN: sqlite3 CLI not found; skipping PRAGMA quick_check.");
    return true;
  }

  const qc = spawnSync(sqlite3, [absFrom, "PRAGMA quick_check;"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const out = ((qc.stdout || "") + (qc.stderr || "")).trim();
  if (qc.status !== 0) {
    console.error("[restore-sqlite] FAILED: sqlite3 quick_check exit", qc.status, out);
    return false;
  }
  if (out !== "ok") {
    console.error("[restore-sqlite] FAILED: PRAGMA quick_check did not return ok:", out.slice(0, 500));
    return false;
  }
  return true;
}

function main() {
  const argv = process.argv.slice(2);
  const { from, confirmLegacy, pm2OfflineRestore, restartPm2Only } = parseArgs(argv);

  if (!from) {
    console.error("[restore-sqlite] Usage:");
    console.error('  npm run restore:db -- /path/to/backup.db');
    console.error("  npm run restore:db -- ./backups/sqlite/chatastay-....db --pm2-offline-restore");
    console.error("Legacy:");
    console.error('  node scripts/restore-sqlite.cjs --from="/path" --confirm-restore [--restart-pm2]');
    process.exit(1);
  }

  const legacyFromFlag = argv.some((a) => a.startsWith("--from="));
  if (legacyFromFlag && !confirmLegacy) {
    console.error("[restore-sqlite] When using --from= you must also pass --confirm-restore");
    process.exit(1);
  }

  const absFrom = path.isAbsolute(from) ? path.normalize(from) : path.resolve(process.cwd(), from);
  if (!fs.existsSync(absFrom)) {
    console.error("[restore-sqlite] FAILED: backup file not found:", absFrom);
    process.exit(1);
  }

  let validated = false;
  try {
    validated = validateSqliteBackup(absFrom);
  } catch (e) {
    console.error("[restore-sqlite] FAILED:", e.message);
    process.exit(1);
  }
  if (!validated) process.exit(1);

  process.chdir(root);
  try {
    require("dotenv").config({ path: path.join(root, ".env") });
  } catch {
    /* optional */
  }

  let liveMain;
  try {
    liveMain = resolveSqliteMainDatabaseFile(root, process.env.DATABASE_URL);
  } catch (e) {
    console.error("[restore-sqlite] FAILED:", e.message);
    process.exit(1);
  }

  console.log("[restore-sqlite] Live database (will be replaced):", liveMain);
  console.log("[restore-sqlite] Restore from:", absFrom);

  if (pm2OfflineRestore) {
    console.log("[restore-sqlite] Stopping PM2 app chatastay …");
    if (!runPm2(["stop", "chatastay"])) {
      console.error("[restore-sqlite] FAILED: pm2 stop chatastay (is PM2 in PATH?)");
      process.exit(1);
    }
  } else {
    console.warn(
      "[restore-sqlite] WARN: ensure the app is not using the DB (stop PM2 first), or pass --pm2-offline-restore for stop → restore → restart."
    );
  }

  const pre = spawnSync(process.execPath, [path.join(root, "scripts", "backup-sqlite.cjs")], {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  if (pre.status !== 0) {
    console.error("[restore-sqlite] FAILED: pre-restore automatic backup failed; aborting.");
    if (pm2OfflineRestore) runPm2(["restart", "chatastay"]);
    process.exit(1);
  }

  const sqlite3 = process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
  const hasSqlite3 = spawnSync(sqlite3, ["-version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).status === 0;

  try {
    if (hasSqlite3) {
      const liveForSql = liveMain.replace(/\\/g, "/").replace(/'/g, "''");
      const r = spawnSync(sqlite3, [absFrom, `.backup '${liveForSql}'`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      if (r.status !== 0) {
        console.error("[restore-sqlite] FAILED: sqlite3 .backup failed:", (r.stderr || r.stdout || "").trim());
        if (pm2OfflineRestore) runPm2(["restart", "chatastay"]);
        process.exit(1);
      }
      removeWalShm(liveMain);
      console.log("[restore-sqlite] OK (sqlite3 .backup into live path)");
    } else {
      const fromWal = `${absFrom}-wal`;
      const fromShm = `${absFrom}-shm`;
      fs.copyFileSync(absFrom, liveMain);
      removeWalShm(liveMain);
      if (fs.existsSync(fromWal)) fs.copyFileSync(fromWal, `${liveMain}-wal`);
      if (fs.existsSync(fromShm)) fs.copyFileSync(fromShm, `${liveMain}-shm`);
      console.log("[restore-sqlite] OK (file copy; install sqlite3 for safer restores)");
    }
  } catch (e) {
    console.error("[restore-sqlite] FAILED:", e.message);
    if (pm2OfflineRestore) runPm2(["restart", "chatastay"]);
    process.exit(1);
  }

  if (pm2OfflineRestore || restartPm2Only) {
    console.log("[restore-sqlite] Restarting PM2 app chatastay …");
    if (!runPm2(["restart", "chatastay"])) {
      console.error("[restore-sqlite] WARN: pm2 restart failed; start manually: pm2 restart chatastay");
      process.exit(1);
    }
    console.log("[restore-sqlite] Done. PM2 restarted.");
  } else {
    console.log("[restore-sqlite] Done. Restart the app: pm2 restart chatastay");
  }
}

main();
