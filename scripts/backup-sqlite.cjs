#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { resolveSqliteMainDatabaseFile } = require("./lib/sqlite-path.cjs");

const root = path.resolve(__dirname, "..");
process.chdir(root);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* optional */
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function uniqueBaseName(dir) {
  for (let i = 0; i < 50; i++) {
    const suffix = i === 0 ? "" : `-${i}`;
    const base = `chatastay-${isoStamp()}${suffix}-${crypto.randomBytes(4).toString("hex")}`;
    const main = path.join(dir, `${base}.db`);
    if (!fs.existsSync(main)) return base;
  }
  throw new Error("Could not allocate unique backup filename");
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, dest);
  return true;
}

function main() {
  let mainDb;
  try {
    mainDb = resolveSqliteMainDatabaseFile(root, process.env.DATABASE_URL);
  } catch (e) {
    console.error("[backup-sqlite] FAILED:", e.message);
    process.exit(1);
  }

  if (!fs.existsSync(mainDb)) {
    console.error("[backup-sqlite] FAILED: database file does not exist:", mainDb);
    process.exit(1);
  }

  const outDir = path.join(root, "backups", "sqlite");
  fs.mkdirSync(outDir, { recursive: true });
  const base = uniqueBaseName(outDir);
  const destMain = path.join(outDir, `${base}.db`);
  const destWal = path.join(outDir, `${base}.db-wal`);
  const destShm = path.join(outDir, `${base}.db-shm`);
  const wal = `${mainDb}-wal`;
  const shm = `${mainDb}-shm`;

  const sqlite3 = process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
  const hasSqlite3 = spawnSync(sqlite3, ["-version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).status === 0;
  const destForSql = destMain.replace(/\\/g, "/").replace(/'/g, "''");

  if (hasSqlite3) {
    const r = spawnSync(sqlite3, [mainDb, `.backup '${destForSql}'`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (r.status !== 0) {
      console.error("[backup-sqlite] sqlite3 .backup failed:", (r.stderr || r.stdout || "").trim());
      console.error("[backup-sqlite] Falling back to file copy (less safe while app writes).");
      try {
        if (fs.existsSync(destMain)) fs.unlinkSync(destMain);
      } catch {
        /* ignore */
      }
    } else {
      const st = fs.statSync(destMain);
      console.log("[backup-sqlite] OK (sqlite3 .backup integrated snapshot)");
      console.log("[backup-sqlite] dest:", destMain);
      console.log("[backup-sqlite] bytes:", st.size);
      process.exit(0);
    }
  } else {
    console.warn("[backup-sqlite] sqlite3 CLI not found; using file copy of main + -wal/-shm if present.");
  }

  try {
    fs.copyFileSync(mainDb, destMain);
    const copiedWal = copyIfExists(wal, destWal);
    const copiedShm = copyIfExists(shm, destShm);
    const st = fs.statSync(destMain);
    console.log("[backup-sqlite] OK (file copy)");
    console.log("[backup-sqlite] dest:", destMain);
    console.log("[backup-sqlite] bytes:", st.size);
    console.log("[backup-sqlite] copied -wal:", copiedWal, "-shm:", copiedShm);
  } catch (e) {
    console.error("[backup-sqlite] FAILED:", e.message);
    try {
      if (fs.existsSync(destMain)) fs.unlinkSync(destMain);
      if (fs.existsSync(destWal)) fs.unlinkSync(destWal);
      if (fs.existsSync(destShm)) fs.unlinkSync(destShm);
    } catch {
      /* best-effort */
    }
    process.exit(1);
  }
}

main();
