#!/usr/bin/env node
// scripts/archive-hotel-safely.cjs
// Suspends a hotel (sets Hotel.isActive=false) AFTER printing a linked-data summary so the operator
// can confirm that no data is being thrown away. NEVER hard-deletes.
//
// Usage:
//   node scripts/archive-hotel-safely.cjs <slug>             # dry-run (default)
//   node scripts/archive-hotel-safely.cjs <slug> --apply     # actually flip isActive=false
//   node scripts/archive-hotel-safely.cjs <slug> --reactivate # set isActive=true again
//
// What this does:
//   1. Loads the Hotel by slug.
//   2. Counts every linked tenant table (bookings, conversations, folios, payments, …).
//   3. Refuses if it's the only currently-active hotel (you'd lock yourself out).
//   4. In --apply mode: sets Hotel.isActive=false and writes an AuditLog entry.
//
// Reversibility: the same script with --reactivate flips it back on. Or use the platform owner UI
// at /owner/hotels → "Activate".

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
const reactivate = args.includes("--reactivate");

if (!slug) {
  console.error("Usage: node scripts/archive-hotel-safely.cjs <slug> [--apply | --reactivate]");
  process.exit(1);
}

let prisma;
try {
  const { PrismaClient } = require("@prisma/client");
  prisma = new PrismaClient();
} catch (err) {
  console.error("[archive-hotel] failed to load @prisma/client. Run `npm install` and `npm run prisma:generate` first.");
  process.exit(2);
}

(async () => {
  const hotel = await prisma.hotel.findUnique({ where: { slug } });
  if (!hotel) {
    console.error(`[archive-hotel] no hotel found for slug "${slug}".`);
    process.exit(1);
  }

  const linkedCounts = {};
  const tables = [
    ["booking", "bookings"],
    ["guest", "guests"],
    ["conversation", "conversations"],
    ["message", "messages"],
    ["property", "properties"],
    ["roomType", "roomTypes"],
    ["roomUnit", "roomUnits"],
    ["outlet", "outlets"],
    ["menuItem", "menuItems"],
    ["folio", "folios"],
    ["folioTransaction", "folioTransactions"],
    ["paymentTransaction", "paymentTransactions"],
    ["notification", "notifications"],
    ["auditLog", "auditLogs"],
    ["hotelUser", "users"],
    ["subscription", "subscriptions"],
    ["lead", "leads"],
    ["housekeepingTask", "housekeepingTasks"],
    ["fbOrder", "fbOrders"],
    ["outletOrderTicket", "outletOrderTickets"],
    ["integrationConnection", "integrationConnections"]
  ];
  for (const [model, label] of tables) {
    if (typeof prisma[model]?.count !== "function") continue;
    try {
      linkedCounts[label] = await prisma[model].count({ where: { hotelId: hotel.id } });
    } catch {
      linkedCounts[label] = "n/a";
    }
  }

  console.log(`[archive-hotel] target: ${hotel.displayName} (slug=${hotel.slug}, id=${hotel.id})`);
  console.log(`[archive-hotel] current isActive: ${hotel.isActive}`);
  console.log(`[archive-hotel] linked counts:`);
  console.log(JSON.stringify(linkedCounts, null, 2));

  if (!apply && !reactivate) {
    console.log(`\n[archive-hotel] DRY-RUN — no changes made.`);
    console.log(`[archive-hotel] Re-run with --apply to suspend, or --reactivate to undo.`);
    await prisma.$disconnect();
    return;
  }

  if (apply) {
    if (!hotel.isActive) {
      console.log(`[archive-hotel] hotel is already suspended; nothing to do.`);
      await prisma.$disconnect();
      return;
    }
    const remainingActive = await prisma.hotel.count({ where: { isActive: true, id: { not: hotel.id } } });
    if (remainingActive === 0) {
      console.error(
        `[archive-hotel] refusing: this is the last active hotel. Suspending it would block all ` +
          `WhatsApp routing and admin operations. Activate another hotel first.`
      );
      process.exit(3);
    }
    await prisma.hotel.update({ where: { id: hotel.id }, data: { isActive: false } });
    await prisma.auditLog.create({
      data: {
        hotelId: hotel.id,
        action: "HOTEL_SUSPENDED_VIA_SCRIPT",
        entityType: "Hotel",
        entityId: hotel.id,
        actorEmail: "scripts/archive-hotel-safely.cjs",
        metadataJson: JSON.stringify({ slug: hotel.slug, linkedCounts })
      }
    });
    console.log(`[archive-hotel] OK — suspended ${hotel.displayName} (isActive=false).`);
    console.log(`[archive-hotel] Reverse with: node scripts/archive-hotel-safely.cjs ${hotel.slug} --reactivate`);
  } else if (reactivate) {
    if (hotel.isActive) {
      console.log(`[archive-hotel] hotel is already active; nothing to do.`);
      await prisma.$disconnect();
      return;
    }
    await prisma.hotel.update({ where: { id: hotel.id }, data: { isActive: true } });
    await prisma.auditLog.create({
      data: {
        hotelId: hotel.id,
        action: "HOTEL_ACTIVATED_VIA_SCRIPT",
        entityType: "Hotel",
        entityId: hotel.id,
        actorEmail: "scripts/archive-hotel-safely.cjs",
        metadataJson: JSON.stringify({ slug: hotel.slug })
      }
    });
    console.log(`[archive-hotel] OK — reactivated ${hotel.displayName} (isActive=true).`);
  }

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("[archive-hotel] failed:", err);
  try {
    await prisma?.$disconnect();
  } catch {}
  process.exit(1);
});
