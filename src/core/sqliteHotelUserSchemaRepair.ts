import type { PrismaClient } from "@prisma/client";

const DUPLICATE_COLUMN = "duplicate column name";

function isSqliteFileDatasource(): boolean {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  return url.startsWith("file:");
}

/**
 * SQLite drift repair: HotelUser may lack password reset / lastLogin columns if
 * schema was updated without a matching migration. Prisma Client expects these
 * columns for RETURNING and selects; missing columns cause P2022 at runtime.
 * ALTERs are idempotent: duplicate column errors are ignored.
 */
export async function ensureHotelUserAuthColumnsSqlite(prisma: PrismaClient): Promise<void> {
  if (!isSqliteFileDatasource()) return;

  const alters = [
    `ALTER TABLE "HotelUser" ADD COLUMN "passwordResetTokenHash" TEXT`,
    `ALTER TABLE "HotelUser" ADD COLUMN "passwordResetExpiresAt" DATETIME`,
    `ALTER TABLE "HotelUser" ADD COLUMN "passwordResetRequestedAt" DATETIME`,
    `ALTER TABLE "HotelUser" ADD COLUMN "lastLoginAt" DATETIME`
  ];

  for (const sql of alters) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes(DUPLICATE_COLUMN)) continue;
      throw e;
    }
  }
}
