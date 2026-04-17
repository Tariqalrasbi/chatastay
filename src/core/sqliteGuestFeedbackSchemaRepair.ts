import type { PrismaClient } from "@prisma/client";

const DUPLICATE_COLUMN = "duplicate column name";

function isSqliteFileDatasource(): boolean {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  return url.startsWith("file:");
}

/**
 * SQLite drift repair: `GuestFeedback` may exist without newer follow-up columns
 * (e.g. partial migration, `db push` mismatch, or hand-edited DB). Prisma Client
 * always selects model columns, so missing columns crash at query time.
 * ALTERs are idempotent: duplicate column errors are ignored.
 */
export async function ensureGuestFeedbackFollowupColumnsSqlite(prisma: PrismaClient): Promise<void> {
  if (!isSqliteFileDatasource()) return;

  const alters = [
    `ALTER TABLE "GuestFeedback" ADD COLUMN "lowRatingAlertedAt" DATETIME`,
    `ALTER TABLE "GuestFeedback" ADD COLUMN "managerFollowUpRequestedAt" DATETIME`,
    `ALTER TABLE "GuestFeedback" ADD COLUMN "managerFollowUpClosedAt" DATETIME`,
    `ALTER TABLE "GuestFeedback" ADD COLUMN "publicReviewClickedAt" DATETIME`,
    `ALTER TABLE "GuestFeedback" ADD COLUMN "isHappyGuest" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "GuestFeedback" ADD COLUMN "isPromoter" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "GuestFeedback" ADD COLUMN "isIssueCase" BOOLEAN NOT NULL DEFAULT false`
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

  try {
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "GuestFeedback_hotelId_managerFollowUpRequestedAt_managerFollowUpClosedAt_idx" ON "GuestFeedback"("hotelId", "managerFollowUpRequestedAt", "managerFollowUpClosedAt")`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(DUPLICATE_COLUMN)) return;
    throw e;
  }
}
