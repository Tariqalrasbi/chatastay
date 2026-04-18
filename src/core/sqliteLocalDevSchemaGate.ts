import type { PrismaClient } from "@prisma/client";

function isSqliteFileDatasource(): boolean {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  return url.startsWith("file:");
}

/** When false, we still run Prisma migrations in CI/prod unchanged; this only affects optional background timers. */
function isRelaxedNodeEnv(): boolean {
  return process.env.NODE_ENV !== "production";
}

async function sqliteTableExists(prisma: PrismaClient, table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table.replace(/'/g, "''")}' LIMIT 1`
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function sqliteColumnExists(prisma: PrismaClient, table: string, column: string): Promise<boolean> {
  if (!(await sqliteTableExists(prisma, table))) return false;
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM pragma_table_info('${table.replace(/'/g, "''")}') WHERE name = '${column.replace(/'/g, "''")}' LIMIT 1`
  );
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Local SQLite only: if the file DB is clearly behind the current Prisma schema, skip background job timers so
 * startup stays usable until `npx prisma migrate deploy` (or `db push`) is run. Production and non-SQLite DBs
 * are unaffected.
 */
export async function localSqliteBackgroundSchedulersEnabled(prisma: PrismaClient): Promise<boolean> {
  if (!isSqliteFileDatasource() || !isRelaxedNodeEnv()) return true;
  if (process.env.CHATASTAY_FORCE_BACKGROUND_JOBS === "true" || process.env.CHATASTAY_FORCE_BACKGROUND_JOBS === "1") {
    return true;
  }

  const checks: Array<{ ok: Promise<boolean>; label: string }> = [
    { ok: sqliteTableExists(prisma, "FolioTransaction"), label: "table FolioTransaction" },
    { ok: sqliteColumnExists(prisma, "Guest", "isVip"), label: "Guest.isVip" },
    { ok: sqliteColumnExists(prisma, "Booking", "bookingGroupId"), label: "Booking.bookingGroupId" },
    { ok: sqliteColumnExists(prisma, "AuditLog", "propertyId"), label: "AuditLog.propertyId" }
  ];

  for (const { ok, label } of checks) {
    if (!(await ok)) {
      console.warn(
        `[chatastay] Local SQLite schema is missing ${label}; background schedulers skipped. ` +
          `Run: npx prisma migrate deploy   (or: npx prisma db push)   Override: CHATASTAY_FORCE_BACKGROUND_JOBS=true`
      );
      return false;
    }
  }
  return true;
}
