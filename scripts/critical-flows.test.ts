/**
 * Minimal in-process HTTP checks for production-critical paths.
 * Run: npm run test:critical
 *
 * Requires a migrated DB (same DATABASE_URL as dev) and seeded demo users (prisma/seed.ts).
 * Mutates DB: creates one guest booking, one manual check-in booking, one checkout; sends test WhatsApp rows.
 */
import "dotenv/config";
import request from "supertest";
import { BookingStatus } from "@prisma/client";
import { createHttpApp } from "../src/httpApp";
import { prisma } from "../src/db";
import { addDays, startOfDay, toIsoDate } from "../src/core/availability";
import { formatYmdInHotelZone, readWallClockInZone, wallClockLocalToUtc } from "../src/core/guestMessagingSchedule";

const HOTEL_SLUG = (process.env.DEFAULT_HOTEL_SLUG ?? "al-ashkhara-beach-resort").trim();
const DEMO_OWNER_EMAIL = "demo.owner@pms.local";
const DEMO_PASSWORD = "PmsDemo2026!";

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

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function assertDigestTimezoneWindow(): void {
  const tz = "Asia/Muscat";
  const sampleUtc = new Date("2026-05-07T08:00:00.000Z");
  const digestKey = formatYmdInHotelZone(sampleUtc, tz);
  const rangeStart = wallClockLocalToUtc(digestKey, "00:00", tz);
  const nextDay = new Date(Date.UTC(2026, 4, 8));
  const rangeEndExclusive = wallClockLocalToUtc(formatYmdInHotelZone(nextDay, tz), "00:00", tz);
  const startWallClock = readWallClockInZone(rangeStart, tz);

  assert(digestKey === "2026-05-07", "digest helper formats Asia/Muscat date as YYYY-MM-DD");
  assert(!Number.isNaN(rangeStart.getTime()), "digest helper converts Asia/Muscat local midnight to UTC");
  assert(!Number.isNaN(rangeEndExclusive.getTime()), "digest helper converts next Asia/Muscat midnight to UTC");
  assert(startWallClock.ymd === digestKey && startWallClock.minOfDay === 0, "digest helper round-trips local midnight");
}

async function main(): Promise<void> {
  if (!process.env.WHATSAPP_VERIFY_TOKEN?.trim()) {
    process.env.WHATSAPP_VERIFY_TOKEN = "crit-flows-verify-token";
  }

  assertDigestTimezoneWindow();

  await prisma.$connect();

  const hotel =
    (await prisma.hotel.findUnique({ where: { slug: HOTEL_SLUG }, select: { id: true, displayName: true } })) ??
    (await prisma.hotel.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, displayName: true } }));
  if (!hotel) {
    console.error("No hotel in DB — run prisma migrate + seed.");
    process.exitCode = 1;
    return;
  }

  let unit = await prisma.roomUnit.findFirst({
    where: { hotelId: hotel.id, isActive: true },
    select: { id: true, name: true }
  });
  if (!unit) {
    const dormant = await prisma.roomUnit.findFirst({
      where: { hotelId: hotel.id },
      select: { id: true }
    });
    if (dormant) {
      await prisma.roomUnit.update({ where: { id: dormant.id }, data: { isActive: true } });
      unit = await prisma.roomUnit.findUniqueOrThrow({ where: { id: dormant.id }, select: { id: true, name: true } });
    }
  }
  if (!unit) {
    const rt = await prisma.roomType.findFirst({
      where: { hotelId: hotel.id, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true }
    });
    if (!rt) {
      console.error("No room types for hotel — run prisma seed / bootstrap.");
      process.exitCode = 1;
      return;
    }
    unit = await prisma.roomUnit.create({
      data: {
        hotelId: hotel.id,
        roomTypeId: rt.id,
        name: `CF-${Date.now().toString(36)}`,
        isActive: true,
        sortOrder: 999
      },
      select: { id: true, name: true }
    });
    console.log(`[test:critical] created scratch room unit ${unit.name} for front-desk tests`);
  }

  const app = createHttpApp();
  const agent = request.agent(app);

  {
    const res = await request(app).get("/");
    assert(res.status === 200 && res.body?.status === "ok", "GET / health JSON");
  }

  {
    const res = await request(app).get(`/admin/login?hotel=${encodeURIComponent(HOTEL_SLUG)}`);
    assert(res.status === 200 && res.text.includes("Login"), "GET /admin/login HTML");
  }

  {
    const res = await request(app)
      .post("/auth/email-login")
      .set("Accept", "application/json")
      .send({ loginId: "not-a-user@invalid.local", password: "wrong", hotelSlug: HOTEL_SLUG });
    assert(res.status === 401 && res.body?.ok === false, "POST /auth/email-login rejects bad credentials (JSON)");
  }

  {
    const res = await agent.post("/auth/email-login").set("Accept", "application/json").send({
      loginId: DEMO_OWNER_EMAIL,
      password: DEMO_PASSWORD,
      hotelSlug: HOTEL_SLUG
    });
    assert(res.status === 200 && res.body?.ok === true && typeof res.body?.redirectTo === "string", "POST /auth/email-login owner session (JSON)");
  }

  {
    const res = await agent.get("/admin/module/front-desk");
    assert(res.status === 200 && res.text.includes("Command Center"), "GET /admin/module/front-desk (dashboard) when authenticated");
  }

  {
    const res = await request(app).post("/api/payments/webhook/thawani").set("Content-Type", "application/json").send("{}");
    assert(res.status === 400 && String(res.body?.error ?? "").length > 0, "Thawani webhook rejects invalid signature (no payment)");
  }

  {
    const res = await request(app).post("/api/payments/webhook/stripe").set("Content-Type", "application/json").send("{}");
    if (res.status === 200 && res.body?.received === true) {
      fail("Stripe must not acknowledge unsigned/invalid payload as a verified processed event");
    } else {
      ok("Stripe webhook rejects or no-ops unsigned test payload (never success+received for junk)");
    }
  }

  {
    const bad = await request(app).get(
      "/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=should-not-return"
    );
    assert(bad.status === 403, "WhatsApp GET verify rejects wrong token");
    const good = await request(app).get(
      `/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
        process.env.WHATSAPP_VERIFY_TOKEN ?? ""
      )}&hub.challenge=echo-ok-123`
    );
    assert(good.status === 200 && good.text === "echo-ok-123", "WhatsApp GET verify echoes challenge");
  }

  {
    const msgId = `wamid.critflow.${Date.now()}`;
    const res = await request(app)
      .post("/whatsapp/webhook")
      .set("Content-Type", "application/json")
      .send({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: "test-phone-number-id" },
                  messages: [
                    {
                      from: "+96891112233",
                      id: msgId,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: "interactive",
                      interactive: { type: "button_reply", button_reply: { id: "hotel_info", title: "Info" } }
                    }
                  ]
                }
              }
            ]
          }
        ]
      });
    assert(res.status === 200, "WhatsApp POST (menu button id) returns 200 (Meta ACK contract)");
  }

  const base = startOfDay(new Date());
  /** Stagger dates by run so re-executing tests does not hit overlapping stays on the same unit. */
  const runSlot = Math.floor(Date.now() / 1000) % 200;
  // Use large day offsets (~11+ yrs) so dev DB inventory noise is unlikely to block `assertInventoryCanReserveTx`.
  const guestCheckIn = addDays(base, 4200 + runSlot);
  const guestCheckOut = addDays(guestCheckIn, 1);
  const guestCheckInStr = toIsoDate(guestCheckIn);
  const guestCheckOutStr = toIsoDate(guestCheckOut);
  const guestPhoneSuffix = String(Date.now()).slice(-7);

  {
    const res = await request(app)
      .post("/guest/book")
      .type("form")
      .send({
        hotelId: hotel.id,
        adults: "2",
        children: "0",
        rooms: "1",
        guestName: "Critical Flow Guest",
        phone: `9689${guestPhoneSuffix}`,
        checkIn: guestCheckInStr,
        checkOut: guestCheckOutStr,
        mealPlan: "NONE",
        paymentPreference: "PAY_LATER",
        lang: "en"
      });
    assert(res.status === 200 && res.text.includes("Booking Confirmed"), "POST /guest/book creates booking (guest flow)");
  }

  const manualCheckIn = addDays(base, 4000 + runSlot);
  const manualCheckOut = addDays(manualCheckIn, 2);
  const departureEarly = addDays(manualCheckIn, 1);
  const manualInStr = ymdLocal(manualCheckIn);
  const manualOutStr = ymdLocal(manualCheckOut);
  const returnBoard = manualInStr;

  {
    const res = await agent.get("/admin/front-desk/check-in");
    assert(res.status === 200 && res.text.includes("Manual check-in"), "GET /admin/front-desk/check-in (auth)");
  }

  {
    const res = await agent.post("/admin/front-desk/check-in").type("form").send({
      guestFullName: "Critical Flow Walk-in",
      guestPhone: `91${guestPhoneSuffix}`,
      guestPhoneCountryCode: "+968",
      guestEmail: "",
      nationality: "",
      idNumber: "",
      internalNotes: "critical-flows.test.ts",
      roomUnitId: unit.id,
      returnBoardDate: returnBoard,
      checkIn: manualInStr,
      checkOut: manualOutStr,
      adults: "2",
      children: "0",
      mealPlan: "NONE",
      paymentStatus: "PENDING",
      paymentMethod: "",
      bookingChannel: "DIRECT"
    });
    const checkInLoc = String(res.headers.location ?? "");
    if (res.status !== 302 || !checkInLoc.includes("manualCheckIn=1")) {
      console.error("[test:critical] POST /admin/front-desk/check-in failed assertion — expected 302 → room-board?…manualCheckIn=1 got:", {
        status: res.status,
        location: checkInLoc || "(missing — often means 200 HTML validation page)",
        bodyPreview: res.text.slice(0, 900)
      });
    }
    assert(
      res.status === 302 && checkInLoc.includes("manualCheckIn=1"),
      "POST /admin/front-desk/check-in redirects to room board with success flag"
    );
  }

  {
    const res = await agent.get(`/admin/room-board?date=${encodeURIComponent(manualInStr)}`);
    assert(res.status === 200 && res.text.includes("Room board"), "GET /admin/room-board after check-in");
  }

  const manualBooking = await prisma.booking.findFirst({
    where: {
      hotelId: hotel.id,
      roomUnitId: unit.id,
      status: { in: [BookingStatus.CHECKED_IN, BookingStatus.CONFIRMED] },
      guest: { fullName: "Critical Flow Walk-in" }
    },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  assert(manualBooking, "Prisma: manual check-in booking exists for walk-in guest (CHECKED_IN or CONFIRMED)");

  {
    const res = await agent.post("/admin/front-desk/check-out").type("form").send({
      roomUnitId: unit.id,
      departureDate: ymdLocal(departureEarly),
      departureTime: "",
      departureReason: "critical-flows test early checkout",
      discountAmount: ""
    });
    assert(res.status === 302 && String(res.headers.location ?? "").includes("manualCheckOut=1"), "POST /admin/front-desk/check-out redirects with success flag");
  }

  {
    const fresh = await prisma.roomUnit.findUnique({ where: { id: unit.id }, select: { notes: true } });
    assert(
      (fresh?.notes ?? "").includes("[status:CLEANING]"),
      "Room unit notes include CLEANING after checkout (room status sync path)"
    );
  }

  await prisma.$disconnect();

  if (failures > 0) {
    console.error(`\ncritical-flows: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\ncritical-flows: all checks passed");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
  void prisma.$disconnect();
});
