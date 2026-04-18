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

    if (hotelMatch) {
      const hid = hotelMatch.id;
      await count("  … Property (this hotel)", () => prisma.property.count({ where: { hotelId: hid } }));
      await count("  … RoomType (this hotel)", () => prisma.roomType.count({ where: { hotelId: hid } }));
      await count("  … Booking (this hotel)", () => prisma.booking.count({ where: { hotelId: hid } }));
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
