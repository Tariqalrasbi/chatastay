#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Uploads the newest timestamped backup from backups/sqlite/ to S3-compatible storage.
 * Requires env vars (see docs/backup-restore.md). Does not run local backup.
 */

const fs = require("node:fs");
const path = require("node:path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const root = path.resolve(__dirname, "..");
const backupDir = path.join(root, "backups", "sqlite");

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`[upload-latest-backup-s3] Missing required env: ${name}`);
    process.exit(1);
  }
  return String(v).trim();
}

function optionalEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || !String(v).trim()) return fallback;
  return String(v).trim();
}

function pickLatestDb() {
  if (!fs.existsSync(backupDir)) {
    console.error("[upload-latest-backup-s3] Backup directory missing:", backupDir);
    process.exit(1);
  }
  const entries = fs
    .readdirSync(backupDir)
    .filter((name) => name.startsWith("chatastay-") && name.endsWith(".db"))
    .map((name) => {
      const full = path.join(backupDir, name);
      const st = fs.statSync(full);
      return { full, name, mtime: st.mtimeMs, size: st.size };
    })
    .filter((e) => e.size > 0);

  if (!entries.length) {
    console.error("[upload-latest-backup-s3] No chatastay-*.db files found in", backupDir);
    process.exit(1);
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  return entries[0];
}

async function main() {
  const bucket = requireEnv("S3_BUCKET");
  const accessKeyId = requireEnv("S3_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("S3_SECRET_ACCESS_KEY");
  const region = optionalEnv("S3_REGION", "us-east-1");
  const endpoint = optionalEnv("S3_ENDPOINT", "");
  const prefix = optionalEnv("S3_PREFIX", "chatastay-backups").replace(/^\/+|\/+$/g, "");
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "1" || process.env.S3_FORCE_PATH_STYLE === "true";

  const latest = pickLatestDb();
  console.log("[upload-latest-backup-s3] Latest file:", latest.full, "bytes:", latest.size);

  const key = `${prefix}/${latest.name}`;

  const clientConfig = {
    region,
    credentials: { accessKeyId, secretAccessKey }
  };
  if (endpoint) {
    clientConfig.endpoint = endpoint;
    clientConfig.forcePathStyle = forcePathStyle;
  }

  const client = new S3Client(clientConfig);
  const body = fs.createReadStream(latest.full);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/x-sqlite3"
    })
  );

  console.log("[upload-latest-backup-s3] OK uploaded s3://", bucket, "/", key);
}

main().catch((e) => {
  console.error("[upload-latest-backup-s3] FAILED:", e.message);
  process.exit(1);
});
