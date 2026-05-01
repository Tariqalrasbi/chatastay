import type { PrismaClient } from "@prisma/client";

const DUPLICATE_COLUMN = "duplicate column name";

function isSqliteFileDatasource(): boolean {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  return url.startsWith("file:");
}

export async function ensureHotelAccountNumbersSqlite(prisma: PrismaClient): Promise<void> {
  if (!isSqliteFileDatasource()) return;

  const existing = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Hotel' LIMIT 1`
  );
  if (!Array.isArray(existing) || existing.length === 0) return;

  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Hotel" ADD COLUMN "accountNumber" INTEGER`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes(DUPLICATE_COLUMN)) throw e;
  }

  const hotels = await prisma.hotel.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, accountNumber: true }
  });
  let next = 1;
  for (const hotel of hotels) {
    if (hotel.accountNumber && hotel.accountNumber >= next) {
      next = hotel.accountNumber + 1;
      continue;
    }
    if (!hotel.accountNumber) {
      while (hotels.some((h) => h.accountNumber === next)) next += 1;
      await prisma.hotel.update({ where: { id: hotel.id }, data: { accountNumber: next } });
      next += 1;
    }
  }

  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Hotel_accountNumber_key" ON "Hotel"("accountNumber")`);
  console.info("[chatastay] SQLite Hotel account numbers checked/backfilled.");
}
