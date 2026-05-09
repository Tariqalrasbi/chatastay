import { PrismaClient, UserRole } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "../src/core/authSecurity";

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_URL ?? "file:./dev.db" }
  }
});

function loadAlAshkharaKnowledgeEntries(): Array<{ category: string; question: string | null; answer: string; locale: string }> {
  const file = path.join(process.cwd(), "src", "data", "al_ashkhara_knowledge.json");
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
  const entries: Array<{ category: string; question: string | null; answer: string; locale: string }> = [];
  const push = (category: string, question: string | null, answer: string | undefined) => {
    const text = String(answer ?? "").trim();
    if (text) entries.push({ category, question, answer: text.slice(0, 2400), locale: "en" });
  };

  const profile = data.hotel_profile ?? {};
  push("general", "What kind of hotel is this?", [profile.hotel_name, profile.short_description, profile.long_description].filter(Boolean).join("\n"));
  const location = data.location ?? {};
  push(
    "directions",
    "Where is the hotel located?",
    [location.village, location.governorate, location.country, location.road_context].filter(Boolean).join(", ")
  );
  const contacts = data.contacts ?? {};
  push(
    "contacts",
    "How can I contact the hotel?",
    [
      contacts.email ? `Email: ${contacts.email}` : "",
      contacts.website ? `Website: ${contacts.website}` : "",
      Array.isArray(contacts.front_desk_mobile) ? `Front desk: ${contacts.front_desk_mobile.join(" / ")}` : "",
      contacts.instagram ? `Instagram: ${contacts.instagram}` : ""
    ].filter(Boolean).join("\n")
  );
  if (Array.isArray(data.room_types)) {
    push(
      "rooms",
      "What room types are available?",
      data.room_types.map((room: any) => `${room.name}: ${room.occupancy_note ?? "Ask us for occupancy details."}`).join("\n")
    );
  }
  if (data.amenities) {
    const groups = Object.entries(data.amenities)
      .map(([group, values]) => `${group}: ${Array.isArray(values) ? values.join(", ") : String(values)}`)
      .join("\n");
    push("services", "What amenities are available?", groups);
  }
  if (data.restaurant) {
    const timings = data.restaurant.meal_timings ?? {};
    push("restaurant", "What are the restaurant hours?", `Breakfast: ${timings.breakfast ?? "ask hotel"}\nLunch: ${timings.lunch ?? "ask hotel"}\nDinner: ${timings.dinner ?? "ask hotel"}`);
  }
  if (Array.isArray(data.activities)) {
    push("activities", "What activities can guests book?", data.activities.map((a: any) => `${a.name}: ${a.details}`).join("\n"));
  }
  if (data.cancellation_policy) {
    push(
      "policies",
      "What is the cancellation policy?",
      [data.cancellation_policy.summary, ...(data.cancellation_policy.rules ?? [])].filter(Boolean).join("\n")
    );
  }
  if (Array.isArray(data.faq_seed)) {
    for (const faq of data.faq_seed) {
      push(String(faq.topic ?? "general"), String(faq.question ?? "").trim() || null, String(faq.answer ?? ""));
    }
  }
  return entries;
}

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

  await prisma.propertyOnboardingProgress.upsert({
    where: { hotelId: hotel.id },
    update: { currentStep: "KNOWLEDGE" },
    create: {
      hotelId: hotel.id,
      currentStep: "KNOWLEDGE",
      completedSteps: JSON.stringify(["BASIC_INFO", "BRANDING", "ROOMS"])
    }
  });

  const demoKnowledgeEntries = loadAlAshkharaKnowledgeEntries();
  if (demoKnowledgeEntries.length) {
    await prisma.propertyKnowledgeEntry.deleteMany({ where: { hotelId: hotel.id, source: "DEMO_TEMPLATE" } });
    await prisma.propertyKnowledgeEntry.createMany({
      data: demoKnowledgeEntries.map((entry) => ({
        hotelId: hotel.id,
        propertyId: property.id,
        category: entry.category,
        question: entry.question,
        answer: entry.answer,
        locale: entry.locale,
        source: "DEMO_TEMPLATE"
      }))
    });
  }

  await prisma.propertyPolicy.deleteMany({ where: { hotelId: hotel.id, type: { in: ["cancellation", "check_in", "child_policy"] } } });
  await prisma.propertyPolicy.createMany({
    data: [
      {
        hotelId: hotel.id,
        propertyId: property.id,
        type: "cancellation",
        title: "Cancellation policy",
        body: "Cancellation terms depend on the booked rate plan. Ask the hotel on WhatsApp before confirming non-refundable or high-season stays."
      },
      {
        hotelId: hotel.id,
        propertyId: property.id,
        type: "check_in",
        title: "Check-in and checkout",
        body: "Standard check-in is from 14:00 and checkout is by 12:00 unless the hotel confirms a different arrangement."
      },
      {
        hotelId: hotel.id,
        propertyId: property.id,
        type: "child_policy",
        title: "Children and extra beds",
        body: "Children and extra-bed requests should be confirmed with the front desk before arrival because room capacity varies by room type."
      }
    ]
  });

  const roomTypes = [
    { code: "STD_SUPERIOR", name: "Standard Superior", capacity: 4, baseNightlyRate: 20, totalInventory: 8 },
    { code: "STD_EXEC", name: "Standard Executive", capacity: 4, baseNightlyRate: 25, totalInventory: 6 },
    { code: "SUITE", name: "Suite", capacity: 5, baseNightlyRate: 30, totalInventory: 7 },
    { code: "APARTMENT", name: "Apartment", capacity: 6, baseNightlyRate: 35, totalInventory: 6 }
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
      maxRoomUnits: 120,
      maxStaffUsers: 20,
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
      maxRoomUnits: 120,
      maxStaffUsers: 20,
      maxMonthlyConversations: 8000,
      supportsChannelManager: true
    }
  });

  const starterPlan = await prisma.plan.upsert({
    where: { code: "starter" },
    update: {
      name: "Starter",
      monthlyPrice: 19,
      maxProperties: 1,
      maxRoomTypes: 12,
      maxRoomUnits: 30,
      maxStaffUsers: 5,
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
      maxRoomUnits: 30,
      maxStaffUsers: 5,
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
      maxRoomUnits: 800,
      maxStaffUsers: 80,
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
      maxRoomUnits: 800,
      maxStaffUsers: 80,
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
  await prisma.hotel.update({
    where: { id: hotel.id },
    data: { subscriptionPlanCode: "growth", subscriptionStatusCached: "ACTIVE" }
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

  const demoHotel = await prisma.hotel.upsert({
    where: { slug: "demo-muscat-boutique" },
    update: {
      displayName: "Demo Muscat Boutique",
      legalName: "Demo Muscat Boutique LLC",
      city: "Muscat",
      timezone: "Asia/Muscat",
      currency: "OMR",
      subscriptionPlanCode: "starter",
      subscriptionStatusCached: "TRIALING",
      description: "A second demo property used to validate tenant isolation and Starter plan limits."
    },
    create: {
      slug: "demo-muscat-boutique",
      displayName: "Demo Muscat Boutique",
      legalName: "Demo Muscat Boutique LLC",
      city: "Muscat",
      timezone: "Asia/Muscat",
      currency: "OMR",
      subscriptionPlanCode: "starter",
      subscriptionStatusCached: "TRIALING",
      description: "A second demo property used to validate tenant isolation and Starter plan limits."
    }
  });
  const demoProperty = await prisma.property.upsert({
    where: { hotelId_name: { hotelId: demoHotel.id, name: "Boutique City Property" } },
    update: { city: "Muscat", addressLine1: "Demo Street, Muscat" },
    create: {
      hotelId: demoHotel.id,
      name: "Boutique City Property",
      city: "Muscat",
      addressLine1: "Demo Street, Muscat",
      checkInTime: "15:00",
      checkOutTime: "11:00"
    }
  });
  await prisma.roomType.upsert({
    where: { propertyId_code: { propertyId: demoProperty.id, code: "CITY_STD" } },
    update: { name: "City Standard", capacity: 2, baseNightlyRate: 28, totalInventory: 5, isActive: true },
    create: {
      hotelId: demoHotel.id,
      propertyId: demoProperty.id,
      code: "CITY_STD",
      name: "City Standard",
      capacity: 2,
      baseNightlyRate: 28,
      totalInventory: 5,
      isActive: true
    }
  });
  await prisma.subscription.upsert({
    where: { id: `${demoHotel.id}_starter_trial` },
    update: { status: "TRIALING", planId: starterPlan.id },
    create: {
      id: `${demoHotel.id}_starter_trial`,
      hotelId: demoHotel.id,
      planId: starterPlan.id,
      status: "TRIALING",
      currentPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-03-15T00:00:00.000Z")
    }
  });
  await prisma.propertyKnowledgeEntry.deleteMany({ where: { hotelId: demoHotel.id, source: "DEMO_TEMPLATE" } });
  await prisma.propertyKnowledgeEntry.createMany({
    data: [
      {
        hotelId: demoHotel.id,
        propertyId: demoProperty.id,
        category: "general",
        question: "What kind of hotel is this?",
        answer: "Demo Muscat Boutique is a compact city hotel used to test that each ChatAstay tenant has its own public content, WhatsApp knowledge, and subscription limits.",
        source: "DEMO_TEMPLATE"
      },
      {
        hotelId: demoHotel.id,
        propertyId: demoProperty.id,
        category: "policies",
        question: "What is the cancellation policy?",
        answer: "Starter demo cancellation policy: free cancellation until 24 hours before arrival unless a non-refundable rate is selected.",
        source: "DEMO_TEMPLATE"
      }
    ]
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

  try {
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
  } catch (err) {
    console.warn(
      "[seed] Sample booking skipped (migrate DB if schema is behind):",
      err instanceof Error ? err.message : err
    );
  }

  const demoPassword = "PmsDemo2026!";
  const demoPasswordHash = await hashPassword(demoPassword);
  const demoPinHash = await hashPassword("4242");

  const demoUsers: Array<{
    email: string;
    username: string;
    fullName: string;
    role: UserRole;
  }> = [
    { email: "demo.owner@pms.local", username: "demoowner", fullName: "Demo Owner", role: UserRole.OWNER },
    { email: "demo.frontdesk@pms.local", username: "demofrontdesk", fullName: "Demo Front Desk", role: UserRole.FRONTDESK },
    { email: "demo.restaurant@pms.local", username: "demorestaurant", fullName: "Demo Restaurant", role: UserRole.STAFF },
    { email: "demo.hk@pms.local", username: "demohk", fullName: "Demo Housekeeping", role: UserRole.HOUSEKEEPING }
  ];

  for (const u of demoUsers) {
    await prisma.hotelUser.upsert({
      where: { hotelId_email: { hotelId: hotel.id, email: u.email } },
      update: {
        fullName: u.fullName,
        username: u.username,
        passwordHash: demoPasswordHash,
        pinHash: demoPinHash,
        role: u.role,
        isActive: true
      },
      create: {
        hotelId: hotel.id,
        fullName: u.fullName,
        email: u.email,
        username: u.username,
        passwordHash: demoPasswordHash,
        pinHash: demoPinHash,
        role: u.role,
        isActive: true
      }
    });
  }

  console.log(`Seed complete for ${hotel.displayName}`);
  console.log(
    "[PMS demo] Email login — password for all: " +
      demoPassword +
      " — " +
      demoUsers.map((u) => u.email).join(", ")
  );
  console.log(
    "[PMS demo] Staff (username + PIN) — PIN for all: 4242 — usernames: " +
      demoUsers.map((u) => u.username).join(", ")
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
