"use strict";

const path = require("node:path");

/**
 * Resolve the on-disk main database file from DATABASE_URL the same way Prisma does
 * for a schema at prisma/schema.prisma (relative file: paths are relative to prisma/).
 */
function resolveSqliteMainDatabaseFile(projectRoot, databaseUrl) {
  const raw = (databaseUrl || "file:./dev.db").trim();
  if (!/^file:/i.test(raw)) {
    throw new Error("Expected DATABASE_URL to start with file: (SQLite)");
  }
  const withoutScheme = raw.replace(/^file:/i, "");
  const schemaDir = path.join(projectRoot, "prisma");

  if (withoutScheme.startsWith("//")) {
    try {
      return decodeURIComponent(new URL(raw).pathname);
    } catch (e) {
      throw new Error(`Invalid file URL in DATABASE_URL: ${e.message}`);
    }
  }

  const rest = withoutScheme.replace(/^\/+/, "");
  if (path.isAbsolute(rest)) {
    return rest;
  }
  return path.resolve(schemaDir, rest);
}

module.exports = { resolveSqliteMainDatabaseFile };
