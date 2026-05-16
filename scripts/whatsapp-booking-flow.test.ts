/**
 * Safe in-process WhatsApp booking flow checks via POST /api/whatsapp/simulate.
 * Run: npm run test:whatsapp-booking
 *
 * Does not call Meta Graph API for outbound sends when WHATSAPP_TOKEN is unset (logged only).
 * Mutates DB: creates guest/conversation/session rows for synthetic phone numbers.
 */
import "dotenv/config";
import request from "supertest";
import { createHttpApp } from "../src/httpApp";
import { prisma } from "../src/db";

const HOTEL_SLUG = (process.env.DEFAULT_HOTEL_SLUG ?? "al-ashkhara-beach-resort").trim();

let failures = 0;

function fail(message: string): void {
  console.error(`\x1b[31m✖\x1b[0m ${message}`);
  failures += 1;
}

function ok(label: string): void {
  console.log(`\x1b[32m✔\x1b[0m ${label}`);
}

function assert(cond: unknown, message: string): void {
  if (!cond) fail(message);
  else ok(message);
}

async function simulate(fromDigits: string, text: string): Promise<void> {
  const app = createHttpApp();
  const res = await request(app).post("/api/whatsapp/simulate").send({ from: fromDigits, text });
  assert(res.status === 200 && res.body?.ok === true, `simulate "${text.slice(0, 40)}" → 200 ok`);
}

async function lastOutboundIntent(hotelId: string, phoneE164: string): Promise<string | null> {
  const guest = await prisma.guest.findFirst({
    where: { hotelId, phoneE164 },
    select: { id: true }
  });
  if (!guest) return null;
  const conv = await prisma.conversation.findFirst({
    where: { hotelId, guestId: guest.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true }
  });
  if (!conv) return null;
  const msg = await prisma.message.findFirst({
    where: { hotelId, conversationId: conv.id, direction: "OUTBOUND" },
    orderBy: { createdAt: "desc" },
    select: { aiIntent: true }
  });
  return msg?.aiIntent ?? null;
}

async function sessionLanguage(hotelId: string, phoneE164: string): Promise<string | null> {
  const guest = await prisma.guest.findFirst({ where: { hotelId, phoneE164 }, select: { id: true } });
  if (!guest) return null;
  const row = await prisma.conversationSession.findUnique({
    where: { hotelId_guestId: { hotelId, guestId: guest.id } },
    select: { language: true, metadataJson: true }
  });
  return row?.language ?? null;
}

async function main(): Promise<void> {
  const hotel = await prisma.hotel.findUnique({ where: { slug: HOTEL_SLUG }, select: { id: true } });
  if (!hotel) {
    console.error("Hotel not found — run migrate + seed.");
    process.exitCode = 1;
    return;
  }

  const suffix = String(Date.now()).slice(-8);

  // First contact: greeting should prompt language selection (not auto English menu).
  {
    const phone = `9687${suffix}01`;
    const e164 = `+${phone}`;
    await simulate(phone, "hello");
    const intent = await lastOutboundIntent(hotel.id, e164);
    assert(
      intent === "LANGUAGE_SELECT_GREETING" || intent === "LANGUAGE_SELECT",
      "first greeting prompts explicit language selection"
    );
    await simulate(phone, "lang_en");
    const lang = await sessionLanguage(hotel.id, e164);
    assert(lang === "en", "lang_en sets session language to en");
  }

  // Change language: must clear prior language and accept new pick.
  {
    const phone = `9687${suffix}02`;
    const e164 = `+${phone}`;
    await simulate(phone, "lang_en");
    await simulate(phone, "change_language");
    await simulate(phone, "lang_ar");
    const lang = await sessionLanguage(hotel.id, e164);
    assert(lang === "ar", "change_language + lang_ar updates session language to ar");
  }

  // Quote cancel at summary stage clears booking session.
  {
    const phone = `9687${suffix}03`;
    const e164 = `+${phone}`;
    const guest = await prisma.guest.upsert({
      where: { hotelId_phoneE164: { hotelId: hotel.id, phoneE164: e164 } },
      update: {},
      create: { hotelId: hotel.id, phoneE164: e164, fullName: "WA Cancel Test" }
    });
    const conv = await prisma.conversation.create({
      data: { hotelId: hotel.id, guestId: guest.id, state: "QUOTED", lastMessageAt: new Date() }
    });
    const checkIn = new Date();
    checkIn.setUTCDate(checkIn.getUTCDate() + 400);
    const checkOut = new Date(checkIn);
    checkOut.setUTCDate(checkOut.getUTCDate() + 2);
    await prisma.conversationSession.upsert({
      where: { hotelId_guestId: { hotelId: hotel.id, guestId: guest.id } },
      create: {
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conv.id,
        phoneE164: e164,
        language: "en",
        stage: "quoted",
        metadataJson: JSON.stringify({
          lastActivityAt: new Date().toISOString(),
          conversationMode: "BOOKING_MODE",
          checkIn: checkIn.toISOString().slice(0, 10),
          checkOut: checkOut.toISOString().slice(0, 10),
          guestCount: 2,
          roomCount: 1,
          suggestedRoomTypeName: "Standard Superior",
          suggestedRoomTypeId: "seed-room-type",
          totalAmount: 120,
          nights: 2
        }),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      },
      update: {
        conversationId: conv.id,
        language: "en",
        stage: "quoted",
        metadataJson: JSON.stringify({
          lastActivityAt: new Date().toISOString(),
          conversationMode: "BOOKING_MODE",
          checkIn: checkIn.toISOString().slice(0, 10),
          checkOut: checkOut.toISOString().slice(0, 10),
          guestCount: 2,
          roomCount: 1,
          suggestedRoomTypeName: "Standard Superior",
          suggestedRoomTypeId: "seed-room-type",
          totalAmount: 120,
          nights: 2
        })
      }
    });
    await simulate(phone, "quote_cancel");
    const intent = await lastOutboundIntent(hotel.id, e164);
    assert(intent === "BOOKING_QUOTE_CANCELLED" || intent === "BOOKING_CANCELLED_MAIN_MENU", "quote_cancel sends cancellation response");
    const sess = await prisma.conversationSession.findUnique({
      where: { hotelId_guestId: { hotelId: hotel.id, guestId: guest.id } },
      select: { stage: true, metadataJson: true }
    });
    assert(sess?.stage === "cancelled" || sess?.stage === "IDLE", "quote_cancel resets session stage");
  }

  // resume_booking during wizard (mid check-in step) should not be ignored.
  {
    const phone = `9687${suffix}04`;
    const e164 = `+${phone}`;
    const guest = await prisma.guest.upsert({
      where: { hotelId_phoneE164: { hotelId: hotel.id, phoneE164: e164 } },
      update: {},
      create: { hotelId: hotel.id, phoneE164: e164, fullName: "WA Resume Test" }
    });
    const conv = await prisma.conversation.create({
      data: { hotelId: hotel.id, guestId: guest.id, state: "QUALIFYING", lastMessageAt: new Date() }
    });
    await prisma.conversationSession.upsert({
      where: { hotelId_guestId: { hotelId: hotel.id, guestId: guest.id } },
      create: {
        hotelId: hotel.id,
        guestId: guest.id,
        conversationId: conv.id,
        phoneE164: e164,
        language: "en",
        stage: "new",
        metadataJson: JSON.stringify({
          lastActivityAt: new Date().toISOString(),
          conversationMode: "BOOKING_MODE",
          bookingStep: "checkin",
          adultCount: 2,
          childCount: 0,
          guestCount: 2,
          roomCount: 1
        }),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      },
      update: {
        conversationId: conv.id,
        metadataJson: JSON.stringify({
          lastActivityAt: new Date().toISOString(),
          conversationMode: "BOOKING_MODE",
          bookingStep: "checkin",
          adultCount: 2,
          childCount: 0,
          guestCount: 2,
          roomCount: 1
        })
      }
    });
    await simulate(phone, "resume_booking");
    const intent = await lastOutboundIntent(hotel.id, e164);
    assert(
      intent === "BOOKING_RETURN_TO_SUMMARY_INCOMPLETE" || intent?.includes("BOOKING") === true,
      "resume_booking during wizard produces booking recovery (not silent drop)"
    );
  }

  await prisma.$disconnect();

  if (failures > 0) {
    console.error(`\nwhatsapp-booking-flow: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nwhatsapp-booking-flow: all checks passed");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
  void prisma.$disconnect();
});
