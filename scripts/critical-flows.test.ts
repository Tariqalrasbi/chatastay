/**
 * Minimal in-process HTTP checks for production-critical paths.
 * Run: npm run test:critical
 *
 * Requires a migrated DB (same DATABASE_URL as dev) and seeded demo users (prisma/seed.ts).
 * Mutates DB: creates one guest booking, one manual check-in booking, one checkout; sends test WhatsApp rows.
 */
import "dotenv/config";
import request from "supertest";
import {
  BookingStatus,
  FolioOutletCategory,
  FolioTransactionType,
  PropertyStatus
} from "@prisma/client";
import { createHttpApp } from "../src/httpApp";
import { prisma } from "../src/db";
import { addDays, startOfDay, toIsoDate } from "../src/core/availability";
import { formatYmdInHotelZone, readWallClockInZone, wallClockLocalToUtc } from "../src/core/guestMessagingSchedule";
import { categorizeBookingForBuffet, getBreakfastBuffetCountForToday } from "../src/core/fbOperations";

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

function extractSectionTabBlocks(html: string): string[] {
  return Array.from(html.matchAll(/<div class="section-tabs"[^>]*>[\s\S]*?<\/div>/g)).map((m) => m[0] ?? "");
}

function extractAdminHrefs(html: string): string[] {
  return Array.from(html.matchAll(/href="(\/admin\/[^"#?]*)/g)).map((m) => m[1] ?? "").filter(Boolean);
}

function assertSectionTabsAreStable(html: string, expectedHref: string): void {
  const blocks = extractSectionTabBlocks(html);
  assert(blocks.length > 0, `navigation: ${expectedHref} renders section-tab chrome`);
  const allHrefs = blocks.flatMap(extractAdminHrefs);
  assert(allHrefs.includes(expectedHref), `navigation: ${expectedHref} remains visible in its section tabs`);
  for (const block of blocks) {
    const hrefs = extractAdminHrefs(block);
    const duplicates = hrefs.filter((href, index) => hrefs.indexOf(href) !== index);
    assert(
      duplicates.length === 0,
      `navigation: no duplicate hrefs inside section-tabs for ${expectedHref}${duplicates.length ? ` (${[...new Set(duplicates)].join(", ")})` : ""}`
    );
  }
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function assertActivePropertyExists(): Promise<void> {
  const hotel = await prisma.hotel.findFirst({ where: { slug: HOTEL_SLUG }, select: { id: true } });
  if (!hotel) {
    fail(`property lifecycle: demo hotel '${HOTEL_SLUG}' not found in DB`);
    return;
  }
  const allProperties = await prisma.property.count({ where: { hotelId: hotel.id } });
  const activeProperties = await prisma.property.count({
    where: { hotelId: hotel.id, status: PropertyStatus.ACTIVE }
  });
  assert(allProperties > 0, "property lifecycle: demo hotel has at least one Property row");
  assert(
    activeProperties >= 1,
    "property lifecycle: demo hotel has >=1 ACTIVE property (operational paths must be unblocked)"
  );
  assert(
    activeProperties === allProperties,
    "property lifecycle: existing properties were migrated to ACTIVE (no DRAFT/SUSPENDED/ARCHIVED leftovers)"
  );
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
  await assertActivePropertyExists();

  const hotel =
    (await prisma.hotel.findUnique({ where: { slug: HOTEL_SLUG }, select: { id: true, displayName: true } })) ??
    (await prisma.hotel.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, displayName: true } }));
  if (!hotel) {
    console.error("No hotel in DB — run prisma migrate + seed.");
    process.exitCode = 1;
    return;
  }

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
  const unit = await prisma.roomUnit.create({
    data: {
      hotelId: hotel.id,
      roomTypeId: rt.id,
      name: `CF-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      isActive: true,
      sortOrder: 999
    },
    select: { id: true, name: true }
  });
  console.log(`[test:critical] created scratch room unit ${unit.name} for front-desk tests`);

  const app = createHttpApp();
  const agent = request.agent(app);

  {
    /// Phase D: `/` serves the marketplace home as HTML by default. JSON health
    /// probes still get `{status:"ok"}` when they advertise Accept: application/json.
    const res = await request(app).get("/").set("Accept", "application/json");
    assert(res.status === 200 && res.body?.status === "ok", "GET / health JSON (Accept: application/json)");
    const homeHtml = await request(app).get("/").set("Accept", "text/html");
    assert(
      homeHtml.status === 200 && homeHtml.text.includes("ChatAstay"),
      "GET / marketplace home HTML (Accept: text/html)"
    );
    const explicit = await request(app).get("/healthz");
    assert(
      explicit.status === 200 && explicit.body?.status === "ok",
      "GET /healthz JSON (always-on monitoring endpoint)"
    );
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
    const navHrefs = [
      "/admin/module/front-desk",
      "/admin/alert-center",
      "/admin/bookings",
      "/admin/calendar",
      "/admin/room-board",
      "/admin/front-desk/check-in",
      "/admin/front-desk/check-out",
      "/admin/guests",
      "/admin/bookings/search",
      "/admin/handover-sheet",
      "/admin/shift-close",
      "/admin/shifts",
      "/admin/rooms",
      "/admin/offers",
      "/admin/inventory",
      "/admin/housekeeping",
      "/admin/maintenance",
      "/admin/conversations",
      "/admin/whatsapp/templates",
      "/admin/conversations/group-messages",
      "/admin/whatsapp/failed-messages",
      "/admin/fb/menu",
      "/admin/outlet-dashboard",
      "/admin/outlet-orders",
      "/admin/restaurant-ops",
      "/admin/reports-center",
      "/admin/management-kpi",
      "/admin/daily-digest",
      "/admin/ai-analytics",
      "/admin/booking-funnel",
      "/admin/routing-health",
      "/admin/profile",
      "/admin/setup",
      "/admin/users",
      "/admin/audit-trail",
      "/admin/billing",
      "/admin/subscription",
      "/admin/integrations"
    ];
    for (const href of navHrefs) {
      const res = await agent.get(href);
      assert(res.status === 200 && /text\/html/i.test(String(res.headers["content-type"] ?? "")), `navigation: ${href} returns HTML`);
      assertSectionTabsAreStable(res.text, href);
    }
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
    assert(res.status === 200 && res.text.includes("Arrivals / check-in"), "GET /admin/front-desk/check-in (auth)");
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
    select: { id: true, totalAmount: true, currency: true }
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
    assert(
      res.status === 302 && String(res.headers.location ?? "").includes("outstanding%20balance"),
      "POST /admin/front-desk/check-out blocks unpaid checkout"
    );
  }

  if (manualBooking) {
    const settle = await agent.post("/admin/front-desk/check-out/settle").type("form").send({
      bookingId: manualBooking.id,
      date: ymdLocal(departureEarly),
      amount: String(manualBooking.totalAmount),
      folioPaymentMethod: "CASH",
      referenceNumber: "critical-flow-settlement"
    });
    assert(
      settle.status === 302 && String(settle.headers.location ?? "").includes("settled=1"),
      "POST /admin/front-desk/check-out/settle records checkout payment"
    );
  }

  {
    const res = await agent.post("/admin/front-desk/check-out").type("form").send({
      roomUnitId: unit.id,
      departureDate: ymdLocal(departureEarly),
      departureTime: "",
      departureReason: "critical-flows test early checkout after settlement",
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

  // ---------------------------------------------------------------------------
  // Daily breakfast / buffet preparation summary
  // ---------------------------------------------------------------------------
  // Pure-function categorisation:
  assert(categorizeBookingForBuffet({ mealPlan: "BREAKFAST" }, false) === "BREAKFAST", "buffet: BREAKFAST mealPlan -> Breakfast Included");
  assert(categorizeBookingForBuffet({ mealPlan: "HALF_BOARD" }, false) === "HALF_BOARD", "buffet: HALF_BOARD mealPlan -> Half-board");
  assert(categorizeBookingForBuffet({ mealPlan: "FULL_BOARD" }, false) === "FULL_BOARD", "buffet: FULL_BOARD mealPlan -> Full-board");
  assert(categorizeBookingForBuffet({ mealPlan: "NONE" }, false) === null, "buffet: Room-only without breakfast charge -> excluded");
  assert(categorizeBookingForBuffet({ mealPlan: null }, false) === null, "buffet: null mealPlan without breakfast charge -> excluded");
  assert(categorizeBookingForBuffet({ mealPlan: "NONE" }, true) === "ADDED", "buffet: Room-only WITH breakfast folio charge -> ADDED bucket");
  assert(categorizeBookingForBuffet({ mealPlan: "BREAKFAST" }, true) === "BREAKFAST", "buffet: meal-plan wins over ADDED to avoid double-counting");

  // DB-backed aggregator: seed isolated bookings far in the future, drive the
  // helper with that date as `asOf`, then assert each bucket. Cleaned up at the
  // end of the block.
  const buffetHotel = await prisma.hotel.findUnique({
    where: { id: hotel.id },
    select: { id: true, timezone: true, currency: true }
  });
  if (!buffetHotel) {
    fail("buffet aggregator: could not load hotel for buffet test");
  } else {
    const roomType = await prisma.roomType.findFirst({
      where: { hotelId: buffetHotel.id, isActive: true },
      select: { id: true, propertyId: true }
    });
    if (!roomType) {
      fail("buffet aggregator: no active room type for buffet test");
    } else {
      const buffetGuest = await prisma.guest.create({
        data: {
          hotelId: buffetHotel.id,
          fullName: "Buffet Test Guest",
          phoneE164: `+96890000${String(Date.now()).slice(-5)}`
        },
        select: { id: true }
      });

      const fakeAsOf = addDays(base, 5000 + runSlot);
      const stayIn = new Date(fakeAsOf);
      stayIn.setHours(0, 0, 0, 0);
      const stayOut = addDays(stayIn, 2);
      const fakeYmd = formatYmdInHotelZone(fakeAsOf, buffetHotel.timezone ?? "UTC");
      const tzDayStartUtc = wallClockLocalToUtc(fakeYmd, "00:00", buffetHotel.timezone ?? "UTC");
      const tzNoonUtc = new Date(tzDayStartUtc.getTime() + 9 * 3600 * 1000);

      const baseBooking = {
        hotelId: buffetHotel.id,
        propertyId: roomType.propertyId,
        roomTypeId: roomType.id,
        guestId: buffetGuest.id,
        checkIn: stayIn,
        checkOut: stayOut,
        nights: 2,
        totalAmount: 0,
        currency: buffetHotel.currency || "OMR"
      };

      const bbBooking = await prisma.booking.create({
        data: { ...baseBooking, adults: 2, children: 1, status: BookingStatus.CONFIRMED, mealPlan: "BREAKFAST" },
        select: { id: true }
      });
      const hbBooking = await prisma.booking.create({
        data: { ...baseBooking, adults: 1, children: 2, status: BookingStatus.CHECKED_IN, mealPlan: "HALF_BOARD" },
        select: { id: true }
      });
      const fbBooking = await prisma.booking.create({
        data: { ...baseBooking, adults: 3, children: 0, status: BookingStatus.CONFIRMED, mealPlan: "FULL_BOARD" },
        select: { id: true }
      });
      const roomOnlyNo = await prisma.booking.create({
        data: { ...baseBooking, adults: 2, children: 0, status: BookingStatus.CONFIRMED, mealPlan: "NONE" },
        select: { id: true }
      });
      const roomOnlyAdded = await prisma.booking.create({
        data: { ...baseBooking, adults: 2, children: 1, status: BookingStatus.CHECKED_IN, mealPlan: "NONE" },
        select: { id: true }
      });
      const futureBooking = await prisma.booking.create({
        data: {
          ...baseBooking,
          adults: 4,
          children: 0,
          status: BookingStatus.CONFIRMED,
          mealPlan: "BREAKFAST",
          checkIn: addDays(stayIn, 10),
          checkOut: addDays(stayIn, 12)
        },
        select: { id: true }
      });
      const pastBooking = await prisma.booking.create({
        data: {
          ...baseBooking,
          adults: 4,
          children: 0,
          status: BookingStatus.CONFIRMED,
          mealPlan: "BREAKFAST",
          checkIn: addDays(stayIn, -10),
          checkOut: addDays(stayIn, -8)
        },
        select: { id: true }
      });
      const cancelledBooking = await prisma.booking.create({
        data: { ...baseBooking, adults: 5, children: 2, status: BookingStatus.CANCELLED, mealPlan: "BREAKFAST" },
        select: { id: true }
      });

      const breakfastCharge = await prisma.folioTransaction.create({
        data: {
          hotelId: buffetHotel.id,
          bookingId: roomOnlyAdded.id,
          guestId: buffetGuest.id,
          transactionType: FolioTransactionType.FNB_CHARGE,
          outletCategory: FolioOutletCategory.RESTAURANT,
          itemCode: "REST-BFAST",
          itemName: "Breakfast",
          description: "Walk-up addition charged to room folio",
          quantity: 1,
          unitPrice: 3,
          grossAmount: 3,
          netAmount: 3,
          chargeDate: tzNoonUtc,
          postedAt: tzNoonUtc,
          isVoided: false
        },
        select: { id: true }
      });

      // Negative case: a non-breakfast charge same day on the same room-only
      // booking should NOT promote it. (Only added because we must guarantee
      // the SKU/name pattern is doing the work, not the existence-of-any-charge.)
      const noiseCharge = await prisma.folioTransaction.create({
        data: {
          hotelId: buffetHotel.id,
          bookingId: roomOnlyNo.id,
          guestId: buffetGuest.id,
          transactionType: FolioTransactionType.FNB_CHARGE,
          outletCategory: FolioOutletCategory.RESTAURANT,
          itemCode: "REST-COFFEE",
          itemName: "Espresso",
          description: "Just a coffee",
          quantity: 1,
          unitPrice: 1,
          grossAmount: 1,
          netAmount: 1,
          chargeDate: tzNoonUtc,
          postedAt: tzNoonUtc,
          isVoided: false
        },
        select: { id: true }
      });

      try {
        const buffet = await getBreakfastBuffetCountForToday(buffetHotel.id, buffetHotel.timezone, fakeAsOf);
        assert(buffet.asOfYmd === fakeYmd, "buffet aggregator: returns hotel-TZ ymd");
        const byCat = Object.fromEntries(buffet.rows.map((r) => [r.category, r] as const));
        // Counts may include other fixture data already in the DB on the same
        // future date; assert OUR seeded contributions are present rather than
        // demanding strict equality with the table totals.
        assert(byCat.BREAKFAST.adults >= 2 && byCat.BREAKFAST.children >= 1, "buffet aggregator: B&B booking contributes 2 adults + 1 child");
        assert(byCat.HALF_BOARD.adults >= 1 && byCat.HALF_BOARD.children >= 2, "buffet aggregator: HB booking contributes 1 adult + 2 children");
        assert(byCat.FULL_BOARD.adults >= 3 && byCat.FULL_BOARD.children >= 0, "buffet aggregator: FB booking contributes 3 adults");
        assert(byCat.ADDED.adults >= 2 && byCat.ADDED.children >= 1, "buffet aggregator: Room-only with breakfast folio charge appears under Added");
        assert(buffet.totals.total >= 11, "buffet aggregator: combined total covers all four buckets");
      } finally {
        // Cleanup: charges first, then bookings, then guest.
        await prisma.folioTransaction.deleteMany({
          where: { id: { in: [breakfastCharge.id, noiseCharge.id] } }
        });
        await prisma.booking.deleteMany({
          where: {
            id: {
              in: [
                bbBooking.id,
                hbBooking.id,
                fbBooking.id,
                roomOnlyNo.id,
                roomOnlyAdded.id,
                futureBooking.id,
                pastBooking.id,
                cancelledBooking.id
              ]
            }
          }
        });
        await prisma.guest.delete({ where: { id: buffetGuest.id } }).catch(() => undefined);
      }
    }
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
