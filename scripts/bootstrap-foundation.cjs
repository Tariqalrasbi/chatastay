#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Idempotent production recovery/bootstrap for an empty SQLite DB.
 *
 * It does NOT delete, truncate, reset, or overwrite bookings/guests/folios.
 * It only upserts foundational PMS records needed for the admin UI to operate:
 * Hotel, Property, RoomType, RoomUnit, plans/subscription, integrations, outlets/menu,
 * and optionally one admin user when BOOTSTRAP_ADMIN_PASSWORD is provided.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { PrismaClient, UserRole } = require("@prisma/client");
const { resolveSqliteMainDatabaseFile } = require("./lib/sqlite-path.cjs");

const scryptAsync = promisify(crypto.scrypt);
const root = path.resolve(__dirname, "..");
process.chdir(root);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* dotenv is present in app deps, but keep script robust */
}

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scryptAsync(secret, salt, 64);
  return `${salt}:${Buffer.from(derived).toString("hex")}`;
}

function env(name, fallback) {
  const v = process.env[name];
  return v == null || String(v).trim() === "" ? fallback : String(v).trim();
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function upsertPlans(prisma) {
  const plans = [
    {
      code: "starter",
      name: "Starter",
      description: "For small hotels starting with WhatsApp bookings",
      monthlyPrice: 19,
      maxProperties: 1,
      maxRoomTypes: 12,
      maxMonthlyConversations: 1500,
      supportsChannelManager: false
    },
    {
      code: "growth",
      name: "Growth",
      description: "For growing hotels with automation and channel integrations",
      monthlyPrice: 49,
      maxProperties: 3,
      maxRoomTypes: 40,
      maxMonthlyConversations: 8000,
      supportsChannelManager: true
    },
    {
      code: "pro",
      name: "Pro",
      description: "For multi-property hospitality groups",
      monthlyPrice: 129,
      maxProperties: 12,
      maxRoomTypes: 200,
      maxMonthlyConversations: 50000,
      supportsChannelManager: true
    }
  ];

  for (const p of plans) {
    await prisma.plan.upsert({
      where: { code: p.code },
      update: p,
      create: p
    });
  }
  return prisma.plan.findUniqueOrThrow({ where: { code: "growth" } });
}

function unitNamesForRoomType(code) {
  switch (code) {
    case "STD_EXEC":
      return ["N1", "N2", "N3", "N4", "N5", "N6"];
    case "STD_SUPERIOR":
      return ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"];
    case "SUITE":
      return ["F1", "F2", "F3", "F4", "F5", "F6", "F7"];
    case "APARTMENT":
      return ["N7", "N8", "N9", "N10", "N11", "N12"];
    default:
      return [];
  }
}

async function upsertRoomUnits(prisma, hotelId, roomType) {
  const names = unitNamesForRoomType(roomType.code);
  for (const [index, name] of names.entries()) {
    await prisma.roomUnit.upsert({
      where: { roomTypeId_name: { roomTypeId: roomType.id, name } },
      update: { hotelId, sortOrder: index + 1, isActive: true },
      create: { hotelId, roomTypeId: roomType.id, name, sortOrder: index + 1, isActive: true }
    });
  }
}

async function upsertForwardInventory(prisma, hotelId, propertyId, roomType, days) {
  const today = startOfDay(new Date());
  for (let i = 0; i < days; i += 1) {
    const date = addDays(today, i);
    await prisma.inventory.upsert({
      where: { roomTypeId_date: { roomTypeId: roomType.id, date } },
      update: { hotelId, propertyId, total: roomType.totalInventory },
      create: {
        hotelId,
        propertyId,
        roomTypeId: roomType.id,
        date,
        total: roomType.totalInventory,
        reserved: 0,
        closedOut: false
      }
    });
  }
}

async function upsertOutlets(prisma, hotelId) {
  const legacyItems = [
    { outletType: "RESTAURANT", name: "Hummus", unitPrice: 1.2, sortOrder: 10 },
    { outletType: "RESTAURANT", name: "Fattoush salad", unitPrice: 2.8, sortOrder: 12 },
    { outletType: "RESTAURANT", name: "Club sandwich", unitPrice: 3.9, sortOrder: 30 },
    { outletType: "RESTAURANT", name: "Grilled hammour", unitPrice: 6.9, sortOrder: 40 },
    { outletType: "RESTAURANT", name: "BBQ Dinner", unitPrice: 8, sortOrder: 47 },
    { outletType: "RESTAURANT", name: "Breakfast", unitPrice: 3, sortOrder: 80 },
    { outletType: "COFFEE_SHOP", name: "Espresso", unitPrice: 1.5, sortOrder: 100 },
    { outletType: "COFFEE_SHOP", name: "Cappuccino", unitPrice: 2.2, sortOrder: 102 },
    { outletType: "COFFEE_SHOP", name: "Latte", unitPrice: 2.2, sortOrder: 103 },
    { outletType: "COFFEE_SHOP", name: "Fresh orange juice", unitPrice: 2, sortOrder: 110 },
    { outletType: "COFFEE_SHOP", name: "Soft drink (can)", unitPrice: 0.8, sortOrder: 115 }
  ];
  const existingLegacy = await prisma.menuItem.findMany({
    where: { hotelId },
    select: { name: true, outletType: true }
  });
  const legacyKeys = new Set(existingLegacy.map((i) => `${i.outletType}::${i.name.toLowerCase()}`));
  const legacyToCreate = legacyItems.filter((i) => !legacyKeys.has(`${i.outletType}::${i.name.toLowerCase()}`));
  if (legacyToCreate.length) {
    await prisma.menuItem.createMany({
      data: legacyToCreate.map((i) => ({ hotelId, currency: "OMR", isActive: true, ...i }))
    });
  }

  const outlets = [
    {
      code: "REST",
      name: "Restaurant",
      outletType: "RESTAURANT",
      items: [
        { itemCode: "REST-BBQ", itemName: "BBQ Dinner", category: "Food", unitPrice: 8 },
        { itemCode: "REST-BFAST", itemName: "Breakfast", category: "Meals", unitPrice: 3 }
      ]
    },
    {
      code: "CAFE",
      name: "Cafe",
      outletType: "CAFE",
      items: [
        { itemCode: "CAFE-COFFEE", itemName: "Coffee", category: "Drinks", unitPrice: 1.5 },
        { itemCode: "CAFE-SNACK", itemName: "Snack", category: "Cafe", unitPrice: 2 }
      ]
    },
    {
      code: "ACT",
      name: "Activities",
      outletType: "ACTIVITY",
      items: [
        { itemCode: "ACT-BIKE", itemName: "Sand bike ride", category: "Activity", unitPrice: 10 },
        { itemCode: "ACT-BUGGY", itemName: "Dune buggy ride", category: "Activity", unitPrice: 20 },
        { itemCode: "ACT-POOL", itemName: "Pool / day access", category: "Activity", unitPrice: 5 }
      ]
    }
  ];

  for (const o of outlets) {
    const outlet = await prisma.outlet.upsert({
      where: { hotelId_code: { hotelId, code: o.code } },
      update: { name: o.name, outletType: o.outletType, isActive: true },
      create: { hotelId, code: o.code, name: o.name, outletType: o.outletType, isActive: true }
    });
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
      } else {
        await prisma.outletMenuItem.create({
          data: { hotelId, outletId: outlet.id, ...item, isActive: true }
        });
      }
    }
  }
}

async function upsertAdminUserIfRequested(prisma, hotelId) {
  const password = env("BOOTSTRAP_ADMIN_PASSWORD", "");
  if (!password) {
    console.log("[bootstrap-foundation] BOOTSTRAP_ADMIN_PASSWORD not set; skipping admin user creation.");
    return;
  }
  const email = env("BOOTSTRAP_ADMIN_EMAIL", "owner@chatastay.local");
  const username = env("BOOTSTRAP_ADMIN_USERNAME", "owner");
  const fullName = env("BOOTSTRAP_ADMIN_NAME", "Hotel Owner");
  const passwordHash = await hashSecret(password);
  const pin = env("BOOTSTRAP_ADMIN_PIN", "");
  const pinHash = pin ? await hashSecret(pin) : null;

  await prisma.hotelUser.upsert({
    where: { hotelId_email: { hotelId, email } },
    update: { fullName, username, passwordHash, ...(pinHash ? { pinHash } : {}), role: UserRole.OWNER, isActive: true },
    create: { hotelId, fullName, email, username, passwordHash, pinHash, role: UserRole.OWNER, isActive: true }
  });
  console.log(`[bootstrap-foundation] Admin user ready: ${email}${pin ? " (PIN set)" : ""}`);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
  const resolvedDb = resolveSqliteMainDatabaseFile(root, databaseUrl);
  console.log("[bootstrap-foundation] DATABASE_URL:", databaseUrl);
  console.log("[bootstrap-foundation] resolved DB:", resolvedDb);
  if (!fs.existsSync(resolvedDb)) {
    console.error("[bootstrap-foundation] FAILED: DB file does not exist:", resolvedDb);
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const slug = env("DEFAULT_HOTEL_SLUG", "al-ashkhara-beach-resort");
    const displayName = env("BOOTSTRAP_HOTEL_NAME", "Al Ashkhara Beach Resort");
    const legalName = env("BOOTSTRAP_HOTEL_LEGAL_NAME", `${displayName} LLC`);
    const city = env("BOOTSTRAP_HOTEL_CITY", "Ashkhara");
    const country = env("BOOTSTRAP_HOTEL_COUNTRY", "OM");
    const timezone = env("BOOTSTRAP_HOTEL_TIMEZONE", "Asia/Muscat");
    const currency = env("BOOTSTRAP_HOTEL_CURRENCY", "OMR");
    const propertyName = env("BOOTSTRAP_PROPERTY_NAME", "Main Beachfront Property");

    const hotel = await prisma.hotel.upsert({
      where: { slug },
      update: { displayName, legalName, city, country, timezone, currency, isActive: true },
      create: { slug, displayName, legalName, city, country, timezone, currency, isActive: true }
    });
    const property = await prisma.property.upsert({
      where: { hotelId_name: { hotelId: hotel.id, name: propertyName } },
      update: {
        city,
        addressLine1: env("BOOTSTRAP_PROPERTY_ADDRESS", "Beach Road, Ashkhara, Oman"),
        checkInTime: env("BOOTSTRAP_CHECK_IN_TIME", "14:00"),
        checkOutTime: env("BOOTSTRAP_CHECK_OUT_TIME", "12:00")
      },
      create: {
        hotelId: hotel.id,
        name: propertyName,
        city,
        addressLine1: env("BOOTSTRAP_PROPERTY_ADDRESS", "Beach Road, Ashkhara, Oman"),
        checkInTime: env("BOOTSTRAP_CHECK_IN_TIME", "14:00"),
        checkOutTime: env("BOOTSTRAP_CHECK_OUT_TIME", "12:00")
      }
    });

    const roomTypes = [
      { code: "STD_SUPERIOR", name: "Standard Superior", capacity: 4, baseNightlyRate: 20, totalInventory: 8 },
      { code: "STD_EXEC", name: "Standard Executive", capacity: 4, baseNightlyRate: 25, totalInventory: 6 },
      { code: "SUITE", name: "Suite", capacity: 5, baseNightlyRate: 30, totalInventory: 7 },
      { code: "APARTMENT", name: "Apartment", capacity: 6, baseNightlyRate: 35, totalInventory: 6 }
    ];

    const inventoryDays = Number.parseInt(env("BOOTSTRAP_INVENTORY_DAYS", "365"), 10);
    for (const rt of roomTypes) {
      const roomType = await prisma.roomType.upsert({
        where: { propertyId_code: { propertyId: property.id, code: rt.code } },
        update: { name: rt.name, capacity: rt.capacity, baseNightlyRate: rt.baseNightlyRate, totalInventory: rt.totalInventory, isActive: true },
        create: { hotelId: hotel.id, propertyId: property.id, ...rt, isActive: true }
      });
      await upsertRoomUnits(prisma, hotel.id, roomType);
      await upsertForwardInventory(prisma, hotel.id, property.id, roomType, Number.isFinite(inventoryDays) ? inventoryDays : 365);
    }

    const growthPlan = await upsertPlans(prisma);
    await prisma.subscription.upsert({
      where: { id: `${hotel.id}_growth_active` },
      update: { planId: growthPlan.id, status: "ACTIVE" },
      create: {
        id: `${hotel.id}_growth_active`,
        hotelId: hotel.id,
        planId: growthPlan.id,
        status: "ACTIVE",
        currentPeriodStart: startOfDay(new Date()),
        currentPeriodEnd: addDays(startOfDay(new Date()), 30)
      }
    });

    for (const provider of ["DIRECT", "BOOKING_COM", "AIRBNB"]) {
      await prisma.integrationConnection.upsert({
        where: { hotelId_provider: { hotelId: hotel.id, provider } },
        update: { status: provider === "DIRECT" ? "connected" : "disconnected" },
        create: { hotelId: hotel.id, provider, status: provider === "DIRECT" ? "connected" : "disconnected" }
      });
    }

    await upsertOutlets(prisma, hotel.id);
    await upsertAdminUserIfRequested(prisma, hotel.id);

    const counts = await Promise.all([
      prisma.hotel.count(),
      prisma.property.count({ where: { hotelId: hotel.id } }),
      prisma.roomType.count({ where: { hotelId: hotel.id, isActive: true } }),
      prisma.roomUnit.count({ where: { hotelId: hotel.id, isActive: true } }),
      prisma.outlet.count({ where: { hotelId: hotel.id, isActive: true } }),
      prisma.outletMenuItem.count({ where: { hotelId: hotel.id, isActive: true } }),
      prisma.hotelUser.count({ where: { hotelId: hotel.id, isActive: true } })
    ]);
    console.log("[bootstrap-foundation] complete");
    console.log("[bootstrap-foundation] hotel:", `${hotel.displayName} (${hotel.slug})`);
    console.log("[bootstrap-foundation] counts:", {
      hotels: counts[0],
      properties: counts[1],
      roomTypes: counts[2],
      roomUnits: counts[3],
      outlets: counts[4],
      outletMenuItems: counts[5],
      activeUsers: counts[6]
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("[bootstrap-foundation] FAILED:", e);
  process.exit(1);
});
