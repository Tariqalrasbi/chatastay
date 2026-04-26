#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Read-only inspection: resolved SQLite path, row counts, hotel slugs vs DEFAULT_HOTEL_SLUG.
 * Run on server: cd /var/www/chatastay && node scripts/inspect-production-data.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { resolveSqliteMainDatabaseFile } = require("./lib/sqlite-path.cjs");

const root = path.resolve(__dirname, "..");
process.chdir(root);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* optional */
}

const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
const adminHotelSlug = (process.env.DEFAULT_HOTEL_SLUG || "al-ashkhara-beach-resort").trim();

let resolvedDbPath = "";
try {
  resolvedDbPath = resolveSqliteMainDatabaseFile(root, databaseUrl);
} catch (e) {
  resolvedDbPath = `(could not resolve: ${e.message})`;
}

async function main() {
  console.log("=== ChatAstay DB inspection (read-only) ===\n");
  console.log("DATABASE_URL (raw):", databaseUrl);
  console.log("Resolved SQLite file:", resolvedDbPath);
  if (resolvedDbPath && fs.existsSync(resolvedDbPath)) {
    const st = fs.statSync(resolvedDbPath);
    console.log("SQLite file exists: yes, bytes:", st.size, "mtime:", st.mtime.toISOString());
  } else if (resolvedDbPath && !resolvedDbPath.startsWith("(")) {
    console.log("SQLite file exists: NO — Prisma would fail or use empty state");
  }

  console.log("\nDEFAULT_HOTEL_SLUG (effective admin slug):", adminHotelSlug);

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } }
  });

  try {
    const hotels = await prisma.hotel.findMany({
      select: { id: true, slug: true, displayName: true },
      orderBy: { createdAt: "asc" }
    });
    console.log("\nHotel rows (" + hotels.length + "):");
    for (const h of hotels) {
      console.log(" ", h.slug, "|", h.displayName, "| id:", h.id.slice(0, 12) + "…");
    }

    const hotelMatch = await prisma.hotel.findUnique({ where: { slug: adminHotelSlug } });
    if (!hotelMatch) {
      console.log(
        "\n*** WARNING: No Hotel row with slug === DEFAULT_HOTEL_SLUG. Admin routes use this slug; set DEFAULT_HOTEL_SLUG in .env to an existing slug above. ***\n"
      );
    } else {
      console.log("\nHotel lookup for DEFAULT_HOTEL_SLUG: OK (id", hotelMatch.id.slice(0, 12) + "…)");
    }

    const count = async (label, fn) => {
      try {
        const n = await fn();
        console.log(label + ":", n);
      } catch (e) {
        console.log(label + ":", "(error)", e.message);
      }
    };

    console.log("\n--- Row counts ---");
    await count("Hotel", () => prisma.hotel.count());
    await count("Property", () => prisma.property.count());
    await count("RoomType", () => prisma.roomType.count());
    await count("RoomUnit", () => prisma.roomUnit.count());
    await count("Booking", () => prisma.booking.count());
    await count("Guest", () => prisma.guest.count());
    await count("HotelUser", () => prisma.hotelUser.count());
    await count("Conversation", () => prisma.conversation.count());
    await count("Message", () => prisma.message.count());
    await count("Folio", () => prisma.folio.count());
    await count("FolioTransaction", () => prisma.folioTransaction.count());
    await count("Outlet", () => prisma.outlet.count());
    await count("OutletMenuItem", () => prisma.outletMenuItem.count());
    await count("MenuItem", () => prisma.menuItem.count());
    await count("Inventory", () => prisma.inventory.count());

    if (hotelMatch) {
      const hid = hotelMatch.id;
      await count("  … Property (this hotel)", () => prisma.property.count({ where: { hotelId: hid } }));
      await count("  … RoomType (this hotel)", () => prisma.roomType.count({ where: { hotelId: hid } }));
      await count("  … RoomUnit (this hotel)", () => prisma.roomUnit.count({ where: { hotelId: hid } }));
      await count("  … Booking (this hotel)", () => prisma.booking.count({ where: { hotelId: hid } }));
      await count("  … Outlet (this hotel)", () => prisma.outlet.count({ where: { hotelId: hid } }));
      await count("  … MenuItem (this hotel)", () => prisma.menuItem.count({ where: { hotelId: hid } }));

      const properties = await prisma.property.findMany({
        where: { hotelId: hid },
        select: { id: true, name: true, city: true },
        take: 5,
        orderBy: { createdAt: "asc" }
      });
      const roomTypes = await prisma.roomType.findMany({
        where: { hotelId: hid },
        select: { id: true, code: true, name: true, totalInventory: true, baseNightlyRate: true },
        take: 8,
        orderBy: { name: "asc" }
      });
      const roomUnits = await prisma.roomUnit.findMany({
        where: { hotelId: hid },
        select: { name: true, roomType: { select: { code: true } } },
        take: 20,
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
      });

      console.log("\n--- Foundation samples for DEFAULT_HOTEL_SLUG ---");
      console.log("Properties:", properties.map((p) => `${p.name}${p.city ? ` (${p.city})` : ""}`).join(" | ") || "(none)");
      console.log("Room types:", roomTypes.map((rt) => `${rt.code}:${rt.name} inv=${rt.totalInventory} rate=${rt.baseNightlyRate}`).join(" | ") || "(none)");
      console.log("Room units:", roomUnits.map((u) => `${u.roomType.code}/${u.name}`).join(" | ") || "(none)");

      if (properties.length === 0 || roomTypes.length === 0 || roomUnits.length === 0) {
        console.log("\n*** WARNING: Found hotel but foundational PMS setup is incomplete. Run npm run bootstrap:foundation after npm run backup:db. ***");
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log("\n=== end ===");
}

main().catch((e) => {
  console.error("inspect-production-data FAILED:", e);
  process.exit(1);
});
