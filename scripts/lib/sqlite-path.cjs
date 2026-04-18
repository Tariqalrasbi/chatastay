"use strict";

const path = require("node:path");

/**
 * Resolve the on-disk main database file from DATABASE_URL the same way Prisma does
 * for a schema at prisma/schema.prisma (relative file: paths are relative to prisma/).
 *
 * Supports:
 * - file:./dev.db (relative → prisma/dev.db)
 * - file:/absolute/path/to.db (POSIX absolute — must NOT strip leading /)
 * - file:///absolute/path (file URL → pathname)
 */
function resolveSqliteMainDatabaseFile(projectRoot, databaseUrl) {
  const raw = (databaseUrl || "file:./dev.db").trim();
  if (!/^file:/i.test(raw)) {
    throw new Error("Expected DATABASE_URL to start with file: (SQLite)");
  }

  const withoutScheme = raw.replace(/^file:/i, "");
  const schemaDir = path.join(projectRoot, "prisma");

  // file:///... or file://hostname/... — use WHATWG URL
  if (withoutScheme.startsWith("//")) {
    try {
      return path.normalize(decodeURIComponent(new URL(raw).pathname));
    } catch (e) {
      throw new Error(`Invalid file URL in DATABASE_URL: ${e.message}`);
    }
  }

  // file:/var/...  →  withoutScheme is already an absolute POSIX path
  if (path.isAbsolute(withoutScheme)) {
    return path.normalize(withoutScheme);
  }

  // file:./dev.db, file:dev.db, etc. — relative to prisma/ (Prisma convention)
  return path.normalize(path.resolve(schemaDir, withoutScheme));
}

module.exports = { resolveSqliteMainDatabaseFile };
