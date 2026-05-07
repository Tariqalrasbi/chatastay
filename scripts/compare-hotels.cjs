#!/usr/bin/env node
// scripts/compare-hotels.cjs
// Read-only multi-tenant comparison report. Usage:
//   node scripts/compare-hotels.cjs <slug-a> <slug-b>
//   node scripts/compare-hotels.cjs al-ashkhara-beach-resort sur-hotel
// Prints a side-by-side JSON of hotel rows, linked-data counts, and the file-based PartnerSetupConfig
// blocks so an operator can decide what (if anything) is worth merging from one tenant into another
// before suspending the second one. NEVER writes to the database.

const fs = require("node:fs");
const path = require("node:path");

let prisma;
try {
  const { PrismaClient } = require("@prisma/client");
  prisma = new PrismaClient();
} catch (err) {
  console.error("[compare-hotels] failed to load @prisma/client. Run `npm install` and `npm run prisma:generate` first.");
  process.exit(2);
}

async function describe(slug) {
  const hotel = await prisma.hotel.findUnique({ where: { slug } });
  if (!hotel) return { slug, exists: false };

  const tableCount = async (model, where) => {
    if (typeof prisma[model]?.count !== "function") return null;
    try {
      return await prisma[model].count({ where });
    } catch {
      return null;
    }
  };

  const counts = {
    bookings: await tableCount("booking", { hotelId: hotel.id }),
    guests: await tableCount("guest", { hotelId: hotel.id }),
    conversations: await tableCount("conversation", { hotelId: hotel.id }),
    messages: await tableCount("message", { hotelId: hotel.id }),
    properties: await tableCount("property", { hotelId: hotel.id }),
    roomTypes: await tableCount("roomType", { hotelId: hotel.id }),
    roomUnits: await tableCount("roomUnit", { hotelId: hotel.id }),
    outlets: await tableCount("outlet", { hotelId: hotel.id }),
    menuItems: await tableCount("menuItem", { hotelId: hotel.id }),
    folios: await tableCount("folio", { hotelId: hotel.id }),
    folioTransactions: await tableCount("folioTransaction", { hotelId: hotel.id }),
    paymentTransactions: await tableCount("paymentTransaction", { hotelId: hotel.id }),
    notifications: await tableCount("notification", { hotelId: hotel.id }),
    auditLogs: await tableCount("auditLog", { hotelId: hotel.id }),
    users: await tableCount("hotelUser", { hotelId: hotel.id }),
    subscriptions: await tableCount("subscription", { hotelId: hotel.id }),
    leads: await tableCount("lead", { hotelId: hotel.id }),
    housekeepingTasks: await tableCount("housekeepingTask", { hotelId: hotel.id }),
    fbOrders: await tableCount("fbOrder", { hotelId: hotel.id }),
    outletOrderTickets: await tableCount("outletOrderTicket", { hotelId: hotel.id }),
    integrationConnections: await tableCount("integrationConnection", { hotelId: hotel.id })
  };

  const sample = {
    propertyNames: (await prisma.property.findMany({ where: { hotelId: hotel.id }, select: { name: true } })).map(
      (p) => p.name
    ),
    roomTypeNames: (
      await prisma.roomType.findMany({
        where: { hotelId: hotel.id },
        select: { name: true, baseNightlyRate: true, isActive: true }
      })
    ).map((r) => `${r.name} (${r.baseNightlyRate} ${hotel.currency}, ${r.isActive ? "active" : "inactive"})`),
    outletCodes: (
      await prisma.outlet.findMany({
        where: { hotelId: hotel.id },
        select: { code: true, displayName: true, isActive: true }
      })
    ).map((o) => `${o.code} · ${o.displayName} (${o.isActive ? "active" : "inactive"})`),
    userEmails: (
      await prisma.hotelUser.findMany({
        where: { hotelId: hotel.id },
        select: { email: true, role: true, isActive: true }
      })
    ).map((u) => `${u.email ?? "(no email)"} · ${u.role}${u.isActive ? "" : " (inactive)"}`)
  };

  return {
    slug,
    exists: true,
    id: hotel.id,
    legalName: hotel.legalName,
    displayName: hotel.displayName,
    isActive: hotel.isActive,
    timezone: hotel.timezone,
    currency: hotel.currency,
    country: hotel.country,
    city: hotel.city,
    accountNumber: hotel.accountNumber,
    whatsappPhone: hotel.whatsappPhone,
    createdAt: hotel.createdAt,
    counts,
    sample
  };
}

function loadPartnerBlock(hotelId) {
  const filePath = path.join(process.cwd(), "partner-setup.json");
  if (!fs.existsSync(filePath)) return { found: false };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const block = raw?.hotels?.[hotelId];
    return { found: Boolean(block), value: block ?? null };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

(async () => {
  const [, , slugA, slugB] = process.argv;
  if (!slugA || !slugB) {
    console.error("Usage: node scripts/compare-hotels.cjs <slug-a> <slug-b>");
    process.exit(1);
  }
  const a = await describe(slugA);
  const b = await describe(slugB);
  const partner = {
    [slugA]: a.exists ? loadPartnerBlock(a.id) : { found: false },
    [slugB]: b.exists ? loadPartnerBlock(b.id) : { found: false }
  };
  const report = { generatedAt: new Date().toISOString(), hotels: { [slugA]: a, [slugB]: b }, partnerSetup: partner };
  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("[compare-hotels] failed:", err);
  try {
    await prisma?.$disconnect();
  } catch {}
  process.exit(1);
});
