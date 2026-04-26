#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Idempotently repairs restaurant/cafe/activity catalogs for an existing hotel.
 * Seeds both:
 * - legacy MenuItem (used by /admin/fb/menu and folio catalog)
 * - Outlet + OutletMenuItem (newer outlet operations catalog)
 */

const path = require("node:path");
const { PrismaClient } = require("@prisma/client");

const root = path.resolve(__dirname, "..");
process.chdir(root);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* optional */
}

const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
const hotelSlug = (process.env.DEFAULT_HOTEL_SLUG || "al-ashkhara-beach-resort").trim();

const legacyItems = [
  // Restaurant
  { outletType: "RESTAURANT", name: "Hummus", unitPrice: 1.2, sortOrder: 10 },
  { outletType: "RESTAURANT", name: "Fattoush salad", unitPrice: 2.8, sortOrder: 12 },
  { outletType: "RESTAURANT", name: "Club sandwich", unitPrice: 3.9, sortOrder: 30 },
  { outletType: "RESTAURANT", name: "Beef burger (180g)", unitPrice: 4.5, sortOrder: 33 },
  { outletType: "RESTAURANT", name: "Grilled hammour", unitPrice: 6.9, sortOrder: 40 },
  { outletType: "RESTAURANT", name: "Mixed seafood grill", unitPrice: 8.5, sortOrder: 42 },
  { outletType: "RESTAURANT", name: "BBQ Dinner", unitPrice: 8, sortOrder: 47 },
  { outletType: "RESTAURANT", name: "Chicken biryani", unitPrice: 5, sortOrder: 53 },
  { outletType: "RESTAURANT", name: "Kids chicken nuggets & fries", unitPrice: 2.9, sortOrder: 60 },
  { outletType: "RESTAURANT", name: "Breakfast", unitPrice: 3, sortOrder: 80 },
  // Cafe
  { outletType: "COFFEE_SHOP", name: "Espresso", unitPrice: 1.5, sortOrder: 100 },
  { outletType: "COFFEE_SHOP", name: "Americano", unitPrice: 1.8, sortOrder: 101 },
  { outletType: "COFFEE_SHOP", name: "Cappuccino", unitPrice: 2.2, sortOrder: 102 },
  { outletType: "COFFEE_SHOP", name: "Latte", unitPrice: 2.2, sortOrder: 103 },
  { outletType: "COFFEE_SHOP", name: "Fresh orange juice", unitPrice: 2, sortOrder: 110 },
  { outletType: "COFFEE_SHOP", name: "Lemon mint cooler", unitPrice: 2, sortOrder: 112 },
  { outletType: "COFFEE_SHOP", name: "Soft drink (can)", unitPrice: 0.8, sortOrder: 115 },
  { outletType: "COFFEE_SHOP", name: "Butter croissant", unitPrice: 1.2, sortOrder: 120 },
  { outletType: "COFFEE_SHOP", name: "Chocolate muffin", unitPrice: 1.5, sortOrder: 121 }
];

const outletCatalog = [
  {
    code: "REST",
    name: "Restaurant",
    outletType: "RESTAURANT",
    items: legacyItems
      .filter((i) => i.outletType === "RESTAURANT")
      .map((i, idx) => ({
        itemCode: `REST-${String(idx + 1).padStart(3, "0")}`,
        itemName: i.name,
        category: "Restaurant",
        unitPrice: i.unitPrice
      }))
  },
  {
    code: "CAFE",
    name: "Cafe",
    outletType: "CAFE",
    items: legacyItems
      .filter((i) => i.outletType === "COFFEE_SHOP")
      .map((i, idx) => ({
        itemCode: `CAFE-${String(idx + 1).padStart(3, "0")}`,
        itemName: i.name,
        category: "Cafe",
        unitPrice: i.unitPrice
      }))
  },
  {
    code: "ACT",
    name: "Activities",
    outletType: "ACTIVITY",
    items: [
      { itemCode: "ACT-BIKE", itemName: "Sand bike ride", category: "Activity", unitPrice: 10 },
      { itemCode: "ACT-BUGGY", itemName: "Dune buggy ride", category: "Activity", unitPrice: 20 },
      { itemCode: "ACT-POOL", itemName: "Pool / day access", category: "Activity", unitPrice: 5 },
      { itemCode: "ACT-BBQ", itemName: "Private beach BBQ setup", category: "Activity", unitPrice: 15 }
    ]
  }
];

async function seedLegacyMenu(prisma, hotelId) {
  const existing = await prisma.menuItem.findMany({
    where: { hotelId },
    select: { id: true, name: true, outletType: true }
  });
  const key = (name, outletType) => `${outletType}::${name.toLowerCase()}`;
  const have = new Map(existing.map((i) => [key(i.name, i.outletType), i.id]));
  let created = 0;
  let updated = 0;

  for (const item of legacyItems) {
    const k = key(item.name, item.outletType);
    const id = have.get(k);
    if (id) {
      await prisma.menuItem.update({
        where: { id },
        data: { unitPrice: item.unitPrice, sortOrder: item.sortOrder, isActive: true }
      });
      updated += 1;
    } else {
      await prisma.menuItem.create({ data: { hotelId, currency: "OMR", isActive: true, ...item } });
      created += 1;
    }
  }
  return { created, updated };
}

async function seedOutletMenu(prisma, hotelId) {
  let outletCount = 0;
  let itemCreated = 0;
  let itemUpdated = 0;

  for (const o of outletCatalog) {
    const outlet = await prisma.outlet.upsert({
      where: { hotelId_code: { hotelId, code: o.code } },
      update: { name: o.name, outletType: o.outletType, isActive: true },
      create: { hotelId, code: o.code, name: o.name, outletType: o.outletType, isActive: true }
    });
    outletCount += 1;

    for (const item of o.items) {
      const existing = await prisma.outletMenuItem.findFirst({
        where: { hotelId, outletId: outlet.id, itemCode: item.itemCode },
        select: { id: true }
      });
      if (existing) {
        await prisma.outletMenuItem.update({
          where: { id: existing.id },
          data: { ...item, isActive: true }
        });
        itemUpdated += 1;
      } else {
        await prisma.outletMenuItem.create({
          data: { hotelId, outletId: outlet.id, ...item, isActive: true }
        });
        itemCreated += 1;
      }
    }
  }
  return { outletCount, itemCreated, itemUpdated };
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const hotel = await prisma.hotel.findUnique({ where: { slug: hotelSlug }, select: { id: true, displayName: true, currency: true } });
    if (!hotel) {
      console.error(`[seed-outlet-menu] FAILED: no Hotel row found for DEFAULT_HOTEL_SLUG=${hotelSlug}`);
      process.exit(1);
    }

    const legacy = await seedLegacyMenu(prisma, hotel.id);
    const outlet = await seedOutletMenu(prisma, hotel.id);
    const [menuItemTotal, outletItemTotal] = await Promise.all([
      prisma.menuItem.count({ where: { hotelId: hotel.id, isActive: true } }),
      prisma.outletMenuItem.count({ where: { hotelId: hotel.id, isActive: true } })
    ]);

    console.log(`[seed-outlet-menu] complete for ${hotel.displayName}`);
    console.log("[seed-outlet-menu] legacy MenuItem:", { ...legacy, activeTotal: menuItemTotal });
    console.log("[seed-outlet-menu] OutletMenuItem:", { ...outlet, activeTotal: outletItemTotal });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("[seed-outlet-menu] FAILED:", e);
  process.exit(1);
});
