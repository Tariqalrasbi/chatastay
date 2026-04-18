import { PrismaClient, UserRole } from "@prisma/client";
import { hashPassword } from "../src/core/authSecurity";

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_URL ?? "file:./dev.db" }
  }
});

async function main(): Promise<void> {
  const hotelSlug = "al-ashkhara-beach-resort";

  const hotel = await prisma.hotel.upsert({
    where: { slug: hotelSlug },
    update: {
      displayName: "Al Ashkhara Beach Resort",
      legalName: "Al Ashkhara Beach Resort LLC",
      city: "Ashkhara",
      timezone: "Asia/Muscat",
      currency: "OMR",
      whatsappPhone: "+96800000000"
    },
    create: {
      slug: hotelSlug,
      displayName: "Al Ashkhara Beach Resort",
      legalName: "Al Ashkhara Beach Resort LLC",
      city: "Ashkhara",
      timezone: "Asia/Muscat",
      currency: "OMR",
      whatsappPhone: "+96800000000"
    }
  });

  const property = await prisma.property.upsert({
    where: { hotelId_name: { hotelId: hotel.id, name: "Main Beachfront Property" } },
    update: {},
    create: {
      hotelId: hotel.id,
      name: "Main Beachfront Property",
      city: "Ashkhara",
      addressLine1: "Beach Road, Ashkhara, Oman",
      checkInTime: "14:00",
      checkOutTime: "12:00"
    }
  });

  const roomTypes = [
    { code: "STD_SUPERIOR", name: "Standard Superior", capacity: 4, baseNightlyRate: 25, totalInventory: 8 },
    { code: "STD_EXEC", name: "Standard Executive", capacity: 4, baseNightlyRate: 30, totalInventory: 6 },
    { code: "SUITE", name: "Suite", capacity: 5, baseNightlyRate: 35, totalInventory: 7 },
    { code: "APARTMENT", name: "Apartment", capacity: 6, baseNightlyRate: 40, totalInventory: 6 }
  ];

  for (const room of roomTypes) {
    const roomType = await prisma.roomType.upsert({
      where: { propertyId_code: { propertyId: property.id, code: room.code } },
      update: {
        name: room.name,
        capacity: room.capacity,
        baseNightlyRate: room.baseNightlyRate,
        totalInventory: room.totalInventory
      },
      create: {
        hotelId: hotel.id,
        propertyId: property.id,
        code: room.code,
        name: room.name,
        capacity: room.capacity,
        baseNightlyRate: room.baseNightlyRate,
        totalInventory: room.totalInventory
      }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await prisma.inventory.upsert({
      where: { roomTypeId_date: { roomTypeId: roomType.id, date: today } },
      update: {
        total: room.totalInventory,
        reserved: room.code === "APARTMENT" ? 3 : 2
      },
      create: {
        hotelId: hotel.id,
        propertyId: property.id,
        roomTypeId: roomType.id,
        date: today,
        total: room.totalInventory,
        reserved: room.code === "APARTMENT" ? 3 : 2
      }
    });
  }

  const activeCodes = roomTypes.map((room) => room.code);
  await prisma.roomType.updateMany({
    where: {
      hotelId: hotel.id,
      code: { notIn: activeCodes }
    },
    data: {
      isActive: false
    }
  });

  const growthPlan = await prisma.plan.upsert({
    where: { code: "growth" },
    update: {
      name: "Growth",
      monthlyPrice: 49,
      maxProperties: 3,
      maxRoomTypes: 40,
      maxMonthlyConversations: 8000,
      supportsChannelManager: true
    },
    create: {
      code: "growth",
      name: "Growth",
      description: "For growing hotels with automation and channel integrations",
      monthlyPrice: 49,
      maxProperties: 3,
      maxRoomTypes: 40,
      maxMonthlyConversations: 8000,
      supportsChannelManager: true
    }
  });

  await prisma.plan.upsert({
    where: { code: "starter" },
    update: {
      name: "Starter",
      monthlyPrice: 19,
      maxProperties: 1,
      maxRoomTypes: 12,
      maxMonthlyConversations: 1500,
      supportsChannelManager: false
    },
    create: {
      code: "starter",
      name: "Starter",
      description: "For small hotels starting with WhatsApp bookings",
      monthlyPrice: 19,
      maxProperties: 1,
      maxRoomTypes: 12,
      maxMonthlyConversations: 1500,
      supportsChannelManager: false
    }
  });

  await prisma.plan.upsert({
    where: { code: "pro" },
    update: {
      name: "Pro",
      monthlyPrice: 129,
      maxProperties: 12,
      maxRoomTypes: 200,
      maxMonthlyConversations: 50000,
      supportsChannelManager: true
    },
    create: {
      code: "pro",
      name: "Pro",
      description: "For multi-property hospitality groups",
      monthlyPrice: 129,
      maxProperties: 12,
      maxRoomTypes: 200,
      maxMonthlyConversations: 50000,
      supportsChannelManager: true
    }
  });

  const subscription = await prisma.subscription.upsert({
    where: { id: `${hotel.id}_growth_active` },
    update: {
      status: "ACTIVE",
      planId: growthPlan.id,
      currentPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-04-01T00:00:00.000Z")
    },
    create: {
      id: `${hotel.id}_growth_active`,
      hotelId: hotel.id,
      planId: growthPlan.id,
      status: "ACTIVE",
      currentPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-04-01T00:00:00.000Z")
    }
  });

  await prisma.invoice.upsert({
    where: { id: "INV-2026-0301" },
    update: {
      hotelId: hotel.id,
      subscriptionId: subscription.id,
      amountSubtotal: 49,
      amountTax: 0,
      amountTotal: 49,
      status: "PAID",
      paidAt: new Date("2026-03-01T08:00:00.000Z")
    },
    create: {
      id: "INV-2026-0301",
      hotelId: hotel.id,
      subscriptionId: subscription.id,
      amountSubtotal: 49,
      amountTax: 0,
      amountTotal: 49,
      status: "PAID",
      paidAt: new Date("2026-03-01T08:00:00.000Z")
    }
  });

  await prisma.integrationConnection.upsert({
    where: { hotelId_provider: { hotelId: hotel.id, provider: "BOOKING_COM" } },
    update: { status: "disconnected" },
    create: {
      hotelId: hotel.id,
      provider: "BOOKING_COM",
      status: "disconnected"
    }
  });

  await prisma.integrationConnection.upsert({
    where: { hotelId_provider: { hotelId: hotel.id, provider: "AIRBNB" } },
    update: { status: "disconnected" },
    create: {
      hotelId: hotel.id,
      provider: "AIRBNB",
      status: "disconnected"
    }
  });

  await prisma.integrationConnection.upsert({
    where: { hotelId_provider: { hotelId: hotel.id, provider: "DIRECT" } },
    update: { status: "connected", lastSyncedAt: new Date("2026-03-05T18:10:00.000Z") },
    create: {
      hotelId: hotel.id,
      provider: "DIRECT",
      status: "connected",
      lastSyncedAt: new Date("2026-03-05T18:10:00.000Z")
    }
  });

  const guest = await prisma.guest.upsert({
    where: { hotelId_phoneE164: { hotelId: hotel.id, phoneE164: "+96890001101" } },
    update: { fullName: "Faisal A." },
    create: {
      hotelId: hotel.id,
      fullName: "Faisal A.",
      phoneE164: "+96890001101",
      locale: "en"
    }
  });

  const executiveRoom = await prisma.roomType.findFirstOrThrow({
    where: { hotelId: hotel.id, code: "STD_EXEC" }
  });

  const demoPassword = "PmsDemo2026!";
  const demoPasswordHash = await hashPassword(demoPassword);
  const demoPinHash = await hashPassword("4242");

  const demoUsers: Array<{
    email: string;
    username: string;
    fullName: string;
    role: UserRole;
    pinHash: string | null;
  }> = [
    { email: "demo.owner@pms.local", username: "demoowner", fullName: "Demo Owner", role: UserRole.OWNER, pinHash: null },
    {
      email: "demo.frontdesk@pms.local",
      username: "demofrontdesk",
      fullName: "Demo Front Desk",
      role: UserRole.FRONTDESK,
      pinHash: null
    },
    {
      email: "demo.restaurant@pms.local",
      username: "demorestaurant",
      fullName: "Demo Restaurant",
      role: UserRole.STAFF,
      pinHash: null
    },
    {
      email: "demo.hk@pms.local",
      username: "demohk",
      fullName: "Demo Housekeeping",
      role: UserRole.HOUSEKEEPING,
      pinHash: demoPinHash
    }
  ];

  for (const u of demoUsers) {
    await prisma.hotelUser.upsert({
      where: { hotelId_email: { hotelId: hotel.id, email: u.email } },
      update: {
        fullName: u.fullName,
        username: u.username,
        passwordHash: demoPasswordHash,
        pinHash: u.pinHash,
        role: u.role,
        isActive: true
      },
      create: {
        hotelId: hotel.id,
        fullName: u.fullName,
        email: u.email,
        username: u.username,
        passwordHash: demoPasswordHash,
        pinHash: u.pinHash,
        role: u.role,
        isActive: true
      }
    });
  }

  await prisma.booking.upsert({
    where: { id: "WS-1009" },
    update: {
      hotelId: hotel.id,
      propertyId: property.id,
      roomTypeId: executiveRoom.id,
      guestId: guest.id,
      checkIn: new Date("2026-03-11T00:00:00.000Z"),
      checkOut: new Date("2026-03-13T00:00:00.000Z"),
      nights: 2,
      adults: 2,
      totalAmount: 70,
      currency: hotel.currency,
      status: "PENDING",
      paymentStatus: "PENDING"
    },
    create: {
      id: "WS-1009",
      hotelId: hotel.id,
      propertyId: property.id,
      roomTypeId: executiveRoom.id,
      guestId: guest.id,
      checkIn: new Date("2026-03-11T00:00:00.000Z"),
      checkOut: new Date("2026-03-13T00:00:00.000Z"),
      nights: 2,
      adults: 2,
      totalAmount: 70,
      currency: hotel.currency,
      status: "PENDING",
      paymentStatus: "PENDING"
    }
  });

  console.log(`Seed complete for ${hotel.displayName}`);
  console.log(
    "[PMS demo] Email/password users (same password for all): " +
      demoUsers.map((u) => `${u.email}`).join(", ") +
      ` — password: ${demoPassword}`
  );
  console.log("[PMS demo] Housekeeping PIN login: username demohk — PIN: 4242");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
