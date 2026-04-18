#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
process.chdir(root);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* dotenv optional if missing */
}

const prismaSchema = path.join(root, "prisma", "schema.prisma");
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const r = spawnSync(npxCmd, ["prisma", "migrate", "deploy", `--schema=${prismaSchema}`], {
  cwd: root,
  env: process.env,
  encoding: "utf8",
  stdio: ["inherit", "pipe", "pipe"]
});

const stdout = r.stdout || "";
const stderr = r.stderr || "";
if (stdout) console.log(stdout);
if (stderr) console.error(stderr);
process.exit(r.status === null ? 1 : r.status);
