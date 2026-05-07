#!/usr/bin/env node
// scripts/delete-hotel-safely.cjs
// HARD-DELETE a hotel and cascade-delete every linked record (bookings, guests, conversations,
// folios, payments, users, properties, rooms, outlets, menu, notifications, audit logs, …).
// IRREVERSIBLE without restoring a SQLite backup. Multi-step confirmation required.
//
// Usage:
//   node scripts/delete-hotel-safely.cjs <slug>
//     ─ dry-run by default; prints the linked-counts that would be destroyed.
//
//   node scripts/delete-hotel-safely.cjs <slug> --apply
//     ─ rejected; requires --yes-hard-delete in addition.
//
//   node scripts/delete-hotel-safely.cjs <slug> --apply --yes-hard-delete
//     ─ performs the destructive delete inside a single Prisma transaction.
//       Writes a HOTEL_HARD_DELETED AuditLog entry to the surviving active hotel FIRST,
//       so the audit trail is preserved even though the deleted hotel's own logs cascade away.
//
// Safety rails:
//   1. Refuses to run if <slug> resolves to the ONLY active hotel (would lock you out).
//   2. Refuses --apply unless --yes-hard-delete is also present.
//   3. Refuses if the database has not been backed up in the last 24h
//      (looks at backups/sqlite/*.db) — pass --skip-backup-check to override.
//   4. Wraps the destructive delete in prisma.$transaction. If anything fails,
//      the whole delete rolls back atomically — no half-deleted hotel.
//
// What is NOT deleted:
//   - Records on OTHER hotels (multi-tenant isolation enforced via where: { hotelId }).
//   - Global Plan rows (Subscription→Plan is Restrict, but Subscription itself cascades from Hotel).
//   - SQLite snapshots in backups/sqlite/.
//
// Recovery if you regret this:
//   ─ stop pm2: pm2 stop chatastay
//   ─ replace prisma/dev.db with the most recent backup:
//       cp backups/sqlite/<latest>.db prisma/dev.db
//   ─ start pm2: pm2 start chatastay

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
const yesHardDelete = args.includes("--yes-hard-delete");
const skipBackupCheck = args.includes("--skip-backup-check");

if (!slug) {
  console.error("Usage: node scripts/delete-hotel-safely.cjs <slug> [--apply --yes-hard-delete]");
  process.exit(1);
}

let prisma;
try {
  const { PrismaClient } = require("@prisma/client");
  prisma = new PrismaClient();
} catch (err) {
  console.error(
    "[delete-hotel] failed to load @prisma/client. Run `npm install` and `npm run prisma:generate` first."
  );
  process.exit(2);
}

function backupRecentEnough() {
  try {
    const dir = path.resolve(process.cwd(), "backups/sqlite");
    if (!fs.existsSync(dir)) return { ok: false, reason: "backups/sqlite/ does not exist" };
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return { ok: false, reason: "no .db files found in backups/sqlite/" };
    const ageMs = Date.now() - files[0].mtime;
    const ageH = ageMs / (1000 * 60 * 60);
    if (ageH > 24) {
      return {
        ok: false,
        reason: `most recent backup ${files[0].f} is ${ageH.toFixed(1)}h old (>24h). Run \`npm run backup:db\` first.`
      };
    }
    return { ok: true, mostRecent: files[0].f, ageH };
  } catch (err) {
    return { ok: false, reason: `backup check failed: ${err.message}` };
  }
}

(async () => {
  const hotel = await prisma.hotel.findUnique({ where: { slug } });
  if (!hotel) {
    console.error(`[delete-hotel] no hotel found for slug "${slug}".`);
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
    ["integrationConnection", "integrationConnections"],
    ["frontDeskShift", "frontDeskShifts"],
    ["invoice", "invoices"]
  ];
  for (const [model, label] of tables) {
    if (typeof prisma[model]?.count !== "function") continue;
    try {
      linkedCounts[label] = await prisma[model].count({ where: { hotelId: hotel.id } });
    } catch {
      linkedCounts[label] = "n/a";
    }
  }

  console.log(`[delete-hotel] target: ${hotel.displayName} (slug=${hotel.slug}, id=${hotel.id})`);
  console.log(`[delete-hotel] currently isActive: ${hotel.isActive}`);
  console.log(`[delete-hotel] linked counts (these will be DESTROYED on --apply):`);
  console.log(JSON.stringify(linkedCounts, null, 2));

  const survivor = await prisma.hotel.findFirst({
    where: { isActive: true, id: { not: hotel.id } },
    orderBy: { createdAt: "asc" },
    select: { id: true, slug: true, displayName: true }
  });
  if (!survivor) {
    console.error(
      "[delete-hotel] refusing: there is no other ACTIVE hotel to keep the audit log on. " +
        "Activate another hotel first, or use scripts/archive-hotel-safely.cjs to suspend instead."
    );
    process.exit(3);
  }
  console.log(`[delete-hotel] surviving hotel for audit log: ${survivor.displayName} (slug=${survivor.slug}).`);

  if (!apply) {
    console.log("\n[delete-hotel] DRY-RUN — no changes made.");
    console.log("[delete-hotel] To actually delete, re-run with: --apply --yes-hard-delete");
    await prisma.$disconnect();
    return;
  }

  if (!yesHardDelete) {
    console.error(
      "\n[delete-hotel] refusing --apply without --yes-hard-delete. This action is IRREVERSIBLE without restoring a backup."
    );
    process.exit(4);
  }

  if (!skipBackupCheck) {
    const bk = backupRecentEnough();
    if (!bk.ok) {
      console.error(`[delete-hotel] refusing: ${bk.reason}`);
      console.error(
        "[delete-hotel] Run `npm run backup:db` first, or pass --skip-backup-check to override at your own risk."
      );
      process.exit(5);
    }
    console.log(`[delete-hotel] backup OK: ${bk.mostRecent} (${bk.ageH.toFixed(1)}h old).`);
  }

  const auditPayload = {
    deletedHotelId: hotel.id,
    deletedHotelSlug: hotel.slug,
    deletedHotelDisplayName: hotel.displayName,
    deletedHotelLegalName: hotel.legalName,
    deletedHotelCreatedAt: hotel.createdAt,
    linkedCounts
  };

  console.log("[delete-hotel] beginning destructive transaction…");
  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        hotelId: survivor.id,
        action: "HOTEL_HARD_DELETED",
        entityType: "Hotel",
        entityId: hotel.id,
        actorEmail: "scripts/delete-hotel-safely.cjs",
        metadataJson: JSON.stringify(auditPayload)
      }
    });
    await tx.hotel.delete({ where: { id: hotel.id } });
  });

  console.log(
    `[delete-hotel] OK — hard-deleted ${hotel.displayName} (slug=${hotel.slug}). All linked records ` +
      `cascade-deleted. Audit log written on ${survivor.slug}.`
  );

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("[delete-hotel] failed:", err);
  try {
    await prisma?.$disconnect();
  } catch {}
  process.exit(1);
});
