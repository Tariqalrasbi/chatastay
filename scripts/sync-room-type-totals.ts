/**
 * One-off / maintenance: set fixed room-type totals for Al Ashkhara Beach Resort
 * and align per-date Inventory.total with RoomType.totalInventory.
 * Run: npx tsx scripts/sync-room-type-totals.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TOTALS_BY_CODE: Record<string, number> = {
  STD_SUPERIOR: 8,
  STD_EXEC: 6,
  SUITE: 7,
  APARTMENT: 6
};

async function main(): Promise<void> {
  const hotel = await prisma.hotel.findUnique({ where: { slug: "al-ashkhara-beach-resort" } });
  if (!hotel) {
    console.error("Hotel al-ashkhara-beach-resort not found.");
    process.exit(1);
  }
  for (const [code, totalInventory] of Object.entries(TOTALS_BY_CODE)) {
    const r = await prisma.roomType.updateMany({
      where: { hotelId: hotel.id, code },
      data: { totalInventory }
    });
    console.log(`RoomType ${code} -> ${totalInventory} (${r.count} row(s))`);
  }
  const types = await prisma.roomType.findMany({
    where: { hotelId: hotel.id },
    select: { id: true, code: true, totalInventory: true }
  });
  const capByTypeId = new Map(types.map((t) => [t.id, t.totalInventory]));
  const invRows = await prisma.inventory.findMany({
    where: { hotelId: hotel.id },
    select: { id: true, roomTypeId: true, reserved: true }
  });
  let invUpdated = 0;
  for (const row of invRows) {
    const cap = capByTypeId.get(row.roomTypeId);
    if (cap === undefined) continue;
    const reserved = Math.min(row.reserved, cap);
    await prisma.inventory.update({
      where: { id: row.id },
      data: { total: cap, reserved }
    });
    invUpdated += 1;
  }
  console.log(`Updated ${invUpdated} inventory row(s) to match room-type totals.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
