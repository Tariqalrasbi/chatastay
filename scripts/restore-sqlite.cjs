#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Restores the live SQLite DB from a backup file created by backup-sqlite.cjs.
 * MUST stop the app (PM2) first so the DB is not open — otherwise restore may fail or corrupt data.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveSqliteMainDatabaseFile } = require("./lib/sqlite-path.cjs");

const root = path.resolve(__dirname, "..");

function parseArgs(argv) {
  let from = "";
  let confirm = false;
  for (const a of argv) {
    if (a.startsWith("--from=")) from = a.slice("--from=".length).trim();
    if (a === "--confirm-restore") confirm = true;
  }
  return { from, confirm };
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

function main() {
  const { from, confirm } = parseArgs(process.argv.slice(2));
  if (!confirm) {
    console.error("[restore-sqlite] Refusing to run without --confirm-restore");
    console.error("[restore-sqlite] Stop PM2 first, then:");
    console.error('[restore-sqlite]   node scripts/restore-sqlite.cjs --from="/abs/path/to/backup.db" --confirm-restore');
    process.exit(1);
  }
  if (!from) {
    console.error("[restore-sqlite] Missing --from=/path/to/backup.db");
    process.exit(1);
  }
  const absFrom = path.isAbsolute(from) ? from : path.resolve(process.cwd(), from);
  if (!fs.existsSync(absFrom)) {
    console.error("[restore-sqlite] Backup file not found:", absFrom);
    process.exit(1);
  }

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

  const pre = spawnSync(process.execPath, [path.join(root, "scripts", "backup-sqlite.cjs")], {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  if (pre.status !== 0) {
    console.error("[restore-sqlite] Pre-restore automatic backup failed; aborting.");
    process.exit(1);
  }

  const sqlite3 = process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
  const hasSqlite3 = spawnSync(sqlite3, ["-version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).status === 0;
  const liveForSql = liveMain.replace(/\\/g, "/").replace(/'/g, "''");

  try {
    if (hasSqlite3) {
      const r = spawnSync(sqlite3, [absFrom, `.backup '${liveForSql}'`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      if (r.status !== 0) {
        console.error("[restore-sqlite] sqlite3 .backup failed:", (r.stderr || r.stdout || "").trim());
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
      console.log("[restore-sqlite] OK (file copy; install sqlite3 CLI for safer integrated backups)");
    }
  } catch (e) {
    console.error("[restore-sqlite] FAILED:", e.message);
    process.exit(1);
  }

  console.log("[restore-sqlite] Done. Start PM2 when ready.");
}

main();
