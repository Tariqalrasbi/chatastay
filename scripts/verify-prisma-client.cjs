#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

const requiredExports = ["PrismaClient", "Prisma", "BookingStatus"];

try {
  const prismaClient = require("@prisma/client");
  const missingExports = requiredExports.filter((name) => !prismaClient[name]);

  if (missingExports.length > 0) {
    throw new Error(`Missing exports from generated @prisma/client: ${missingExports.join(", ")}`);
  }

  console.log("[prisma:verify] Generated Prisma client exports are present.");
} catch (error) {
  console.error("[prisma:verify] Prisma client is not generated correctly.");
  console.error(error instanceof Error ? error.message : error);
  console.error("");
  console.error("Run this on the server from the app directory:");
  console.error("  rm -rf node_modules/.prisma node_modules/@prisma/client");
  console.error("  npm ci");
  console.error("  npm run prisma:generate");
  process.exit(1);
}
