import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db";
import { findAvailableRoomType, getDayAvailability, toIsoDate } from "../core/availability";
import { loadPartnerSetupConfig } from "../core/partnerSetup";
import { markCalendarSessionUsed, resolveCalendarSession, saveConversationSession, upsertBookingDraft } from "../core/sessionStore";
import { sendWhatsAppButtons, sendWhatsAppText } from "../whatsapp/send";

export const guestRouter = Router();

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizePhone(input: string): string {
  return input.replace(/\D/g, "");
}

function formatDate(input: Date): string {
  return input.toISOString().slice(0, 10);
}

function addDays(input: Date, days: number): Date {
  const next = new Date(input);
  next.setDate(next.getDate() + days);
  return next;
}

const defaultHotelSlug = process.env.DEFAULT_HOTEL_SLUG ?? "al-ashkhara-beach-resort";
const offersFile = path.join(process.cwd(), "hotel-offers.json");

type GuestOffer = {
  id: string;
  code: string;
  title: string;
  type: string;
  discountPercent: number;
  isActive: boolean;
  seasonStart?: string;
  seasonEnd?: string;
  minNights?: number;
  minDaysBeforeCheckIn?: number;
  stayX?: number;
  stayY?: number;
  corporateOnly?: boolean;
};

function readActiveOffersForGuest(): GuestOffer[] {
  try {
    if (!fs.existsSync(offersFile)) return [];
    const raw = JSON.parse(fs.readFileSync(offersFile, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return (raw as GuestOffer[]).filter((offer) => offer.isActive);
  } catch {
    return [];
  }
}

function parseIntSafe(raw: unknown, fallback: number, min: number, max: number): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function monthStartFromRaw(raw: string | undefined): Date {
  if (!raw) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const parsed = new Date(`${raw}-01T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return new Date(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1);
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return new Date(next.getFullYear(), next.getMonth(), 1);
}

function formatMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function guestLayout(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ChatStay Guest Portal</title>
  <style>
    body { font-family: Inter, Arial, sans-serif; margin: 0; background: linear-gradient(180deg, #f6fbf9 0%, #eef7f4 100%); color: #0f172a; }
    main { max-width: 860px; margin: 20px auto; background: #ffffff; border: 1px solid #d8eee5; border-radius: 16px; padding: 18px; box-shadow: 0 8px 28px rgba(7, 94, 84, 0.08); }
    h1, h2 { margin-top: 0; }
    .muted { color: #475569; }
    .inline-link { color:#0b6e6e; font-weight: 700; text-decoration: none; padding: 6px 10px; border-radius: 999px; background: #ecfff5; border:1px solid #bbf7d0; }
    .inline-link:hover { text-decoration: underline; }
    .badge { display:inline-block; padding:4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .ok { background:#dcfce7; color:#166534; }
    .pending { background:#fef9c3; color:#854d0e; }
    .alert { background:#fee2e2; color:#991b1b; }
    table { width:100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align:left; border-bottom: 1px solid #e2e8f0; padding: 9px 8px; }
    form { display:grid; gap: 8px; max-width: 460px; }
    input { padding: 9px; border:1px solid #cbd5e1; border-radius: 8px; }
    button { border:0; background:#075e54; color:#fff; padding:10px 14px; border-radius: 10px; font-weight: 700; cursor: pointer; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .row { display:grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
    @media (max-width: 700px) {
      .row { grid-template-columns: 1fr; }
      main { margin: 0; min-height: 100vh; border-radius: 0; border: 0; padding: 14px; }
    }
  </style>
  <link rel="stylesheet" href="/static/guest-calendar.css" />
  <script src="/static/guest-calendar.js" defer></script>
</head>
<body>
  <main>${content}</main>
</body>
</html>`;
}

guestRouter.get("/", async (req, res) => {
  const bookingId = typeof req.query.bookingId === "string" ? req.query.bookingId.trim() : "";
  const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : "";
  const error = typeof req.query.error === "string" ? req.query.error.trim() : "";

  if (!bookingId || !phone) {
    const hotel =
      (await prisma.hotel.findUnique({
        where: { slug: defaultHotelSlug },
        include: { roomTypes: { where: { isActive: true }, orderBy: { name: "asc" } } }
      })) ??
      (await prisma.hotel.findFirst({
        include: { roomTypes: { where: { isActive: true }, orderBy: { name: "asc" } } }
      }));
    const offers = readActiveOffersForGuest();

    const roomRows = hotel?.roomTypes
      .map(
        (room) => `<tr>
      <td>${escapeHtml(room.name)}</td>
      <td>${room.capacity}</td>
      <td>${room.baseNightlyRate.toFixed(2)} ${escapeHtml(hotel.currency)}</td>
      <td>${room.totalInventory}</td>
    </tr>`
      )
      .join("");

    const offerRows = offers
      .map((offer) => {
        const conditionParts: string[] = [];
        if (offer.type === "STAY_X_GET_Y_FREE" && offer.stayX && offer.stayY) conditionParts.push(`Stay ${offer.stayX} get ${offer.stayY} free`);
        if (offer.type === "EARLY_BOOKING" && offer.minDaysBeforeCheckIn) conditionParts.push(`${offer.minDaysBeforeCheckIn}+ days ahead`);
        if (offer.type === "LONG_STAY" && offer.minNights) conditionParts.push(`${offer.minNights}+ nights`);
        if (offer.type === "SEASONAL" && offer.seasonStart && offer.seasonEnd) conditionParts.push(`${offer.seasonStart} to ${offer.seasonEnd}`);
        if (offer.corporateOnly) conditionParts.push("Corporate only");
        return `<tr>
      <td>${escapeHtml(offer.title)}</td>
      <td>${escapeHtml(offer.type)}</td>
      <td>${offer.discountPercent}%</td>
      <td>${escapeHtml(conditionParts.join(" • ") || "Standard offer terms")}</td>
    </tr>`;
      })
      .join("");

    const contactPhone = normalizePhone(hotel?.whatsappPhone ?? "");
    const waLink = contactPhone ? `https://wa.me/${encodeURIComponent(contactPhone)}` : "";

    const content = `
<h1>Guest Booking Portal</h1>
<p class="muted">View rooms and offers, check booking details, and contact the hotel.</p>
${error ? `<p class="badge alert">${escapeHtml(error)}</p>` : ""}
<section style="margin-bottom:14px">
  <h2>Rooms</h2>
  <table>
    <thead><tr><th>Room</th><th>Capacity</th><th>Rate</th><th>Inventory</th></tr></thead>
    <tbody>${roomRows || '<tr><td colspan="4">No rooms available.</td></tr>'}</tbody>
  </table>
  <p style="margin-top:10px"><a class="inline-link" href="/guest/calendar${hotel ? `?hotelId=${encodeURIComponent(hotel.id)}` : ""}">Check availability calendar</a></p>
</section>
<section style="margin-bottom:14px">
  <h2>Offers</h2>
  <table>
    <thead><tr><th>Offer</th><th>Type</th><th>Discount</th><th>Details</th></tr></thead>
    <tbody>${offerRows || '<tr><td colspan="4">No active offers right now.</td></tr>'}</tbody>
  </table>
</section>
<section style="margin-bottom:14px">
  <h2>Contact Hotel</h2>
  <p class="muted">Need help? Contact our team directly.</p>
  <div style="display:flex; gap:8px; flex-wrap:wrap">
    ${waLink ? `<a class="inline-link" href="${waLink}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ""}
    ${hotel?.whatsappPhone ? `<span class="inline-link" style="text-decoration:none">${escapeHtml(hotel.whatsappPhone)}</span>` : ""}
    <a class="inline-link" href="mailto:${escapeHtml(process.env.ADMIN_EMAIL ?? "reservations@chatastay.local")}">Email hotel</a>
  </div>
</section>
<section>
<h2>Check Booking Details</h2>
<p class="muted">Enter your booking information to view stay and payment status.</p>
<form method="post" action="/guest/lookup">
  <label>Booking ID
    <input type="text" name="bookingId" value="${escapeHtml(bookingId)}" placeholder="WB-ABC123" required />
  </label>
  <label>Phone number used for booking
    <input type="text" name="phone" value="${escapeHtml(phone)}" placeholder="9689XXXXXXX" required />
  </label>
  <button type="submit">Check Booking</button>
</form>
</section>`;
    res.type("html").send(guestLayout(content));
    return;
  }

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId },
    include: { guest: true, hotel: true, property: true, roomType: true }
  });
  if (!booking) {
    res.redirect("/guest?error=Booking+not+found");
    return;
  }

  const expectedPhone = normalizePhone(booking.guest.phoneE164);
  const providedPhone = normalizePhone(phone);
  const phoneMatches =
    expectedPhone === providedPhone || expectedPhone.endsWith(providedPhone) || providedPhone.endsWith(expectedPhone);
  if (!phoneMatches) {
    res.redirect("/guest?error=Phone+number+does+not+match+booking+record");
    return;
  }

  const badgeClass =
    booking.status === "CONFIRMED" ? "ok" : booking.status === "CANCELLED" || booking.status === "NO_SHOW" ? "alert" : "pending";
  const paymentBadgeClass =
    booking.paymentStatus === "SUCCEEDED" ? "ok" : booking.paymentStatus === "FAILED" ? "alert" : "pending";

  const content = `
<h1>Booking Details</h1>
<p class="muted">Welcome ${escapeHtml(booking.guest.fullName ?? "Guest")}, this is your latest booking information.</p>
<div class="row">
  <article>
    <h2>Stay Summary</h2>
    <table>
      <tbody>
        <tr><th>Booking ID</th><td>${escapeHtml(booking.id)}</td></tr>
        <tr><th>Hotel</th><td>${escapeHtml(booking.hotel.displayName)}</td></tr>
        <tr><th>Property</th><td>${escapeHtml(booking.property.name)}</td></tr>
        <tr><th>Room Type</th><td>${escapeHtml(booking.roomType.name)}</td></tr>
        <tr><th>Check-in</th><td>${formatDate(booking.checkIn)}</td></tr>
        <tr><th>Check-out</th><td>${formatDate(booking.checkOut)}</td></tr>
        <tr><th>Nights</th><td>${booking.nights}</td></tr>
      </tbody>
    </table>
  </article>
  <article>
    <h2>Status</h2>
    <table>
      <tbody>
        <tr><th>Booking Status</th><td><span class="badge ${badgeClass}">${escapeHtml(booking.status)}</span></td></tr>
        <tr><th>Payment Status</th><td><span class="badge ${paymentBadgeClass}">${escapeHtml(booking.paymentStatus)}</span></td></tr>
        <tr><th>Total Amount</th><td>${booking.totalAmount.toFixed(2)} ${escapeHtml(booking.currency)}</td></tr>
        <tr><th>Adults</th><td>${booking.adults}</td></tr>
        <tr><th>Children</th><td>${booking.children}</td></tr>
      </tbody>
    </table>
  </article>
</div>
<p style="margin-top:12px"><a href="/guest">Check another booking</a></p>`;

  res.type("html").send(guestLayout(content));
});

guestRouter.post("/lookup", (req, res) => {
  const bookingId = String(req.body.bookingId ?? "").trim();
  const phone = String(req.body.phone ?? "").trim();
  if (!bookingId || !phone) {
    res.redirect("/guest?error=Please+provide+both+Booking+ID+and+phone+number");
    return;
  }
  const query = new URLSearchParams({ bookingId, phone });
  res.redirect(`/guest?${query.toString()}`);
});

guestRouter.get("/book-now", async (req, res) => {
  const query = new URLSearchParams();
  const hotelId = typeof req.query.hotelId === "string" ? req.query.hotelId.trim() : "";
  const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : "";
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (hotelId) query.set("hotelId", hotelId);
  if (phone) query.set("phone", phone);
  if (token) query.set("token", token);
  res.redirect(`/guest/calendar?${query.toString()}`);
});

guestRouter.get("/calendar", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  const hotelIdFromQuery = typeof req.query.hotelId === "string" ? req.query.hotelId.trim() : "";
  const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : "";
  const guestName = typeof req.query.guestName === "string" ? req.query.guestName.trim() : "";
  const error = typeof req.query.error === "string" ? req.query.error.trim() : "";
  const month = monthStartFromRaw(typeof req.query.month === "string" ? req.query.month.trim() : undefined);
  const guests = parseIntSafe(req.query.guests, 2, 1, 16);
  const rooms = parseIntSafe(req.query.rooms, 1, 1, 6);

  let resolvedHotelId = hotelIdFromQuery;
  if (token) {
    try {
      const session = await resolveCalendarSession(token);
      resolvedHotelId = session.hotelId;
    } catch (sessionError) {
      const message = sessionError instanceof Error ? sessionError.message : "Invalid calendar session";
      const query = new URLSearchParams({ error: message });
      if (hotelIdFromQuery) query.set("hotelId", hotelIdFromQuery);
      res.redirect(`/guest/calendar?${query.toString()}`);
      return;
    }
  }

  const hotel =
    (resolvedHotelId
      ? await prisma.hotel.findUnique({ where: { id: resolvedHotelId } })
      : await prisma.hotel.findUnique({ where: { slug: defaultHotelSlug } })) ??
    (await prisma.hotel.findFirst({ orderBy: { createdAt: "asc" } }));
  if (!hotel) {
    res.type("html").send(guestLayout("<h1>Booking Calendar</h1><p class=\"badge alert\">No hotel found.</p>"));
    return;
  }

  const monthKey = formatMonthKey(month);
  const prevMonth = formatMonthKey(addMonths(month, -1));
  const nextMonth = formatMonthKey(addMonths(month, 1));
  const preserved = new URLSearchParams({
    hotelId: hotel.id,
    guests: String(guests),
    rooms: String(rooms),
    month: monthKey
  });
  if (token) preserved.set("token", token);
  if (phone) preserved.set("phone", phone);
  if (guestName) preserved.set("guestName", guestName);

  const content = `
<h1>Mini Booking Calendar</h1>
<p class="muted">This mini calendar only allows selectable available dates.</p>
${error ? `<p class="badge alert">${escapeHtml(error)}</p>` : ""}
<form method="get" action="/guest/calendar" class="calendar-form compact-controls" style="display:grid; gap:8px; margin-bottom:12px">
  <input type="hidden" name="hotelId" value="${escapeHtml(hotel.id)}" />
  ${token ? `<input type="hidden" name="token" value="${escapeHtml(token)}" />` : ""}
  <input type="hidden" name="month" value="${escapeHtml(monthKey)}" />
  <div class="row">
    <label>Guests
      <input type="number" name="guests" min="1" max="16" value="${guests}" />
    </label>
    <label>Rooms
      <input type="number" name="rooms" min="1" max="6" value="${rooms}" />
    </label>
  </div>
  <div class="calendar-head">
    <a href="/guest/calendar?${new URLSearchParams({ ...Object.fromEntries(preserved.entries()), month: prevMonth }).toString()}" class="inline-link">Previous month</a>
    <a href="/guest/calendar?${new URLSearchParams({ ...Object.fromEntries(preserved.entries()), month: nextMonth }).toString()}" class="inline-link">Next month</a>
  </div>
  <button type="submit">Refresh availability</button>
</form>
<section class="mini-chat-wrap">
  <article class="mini-bubble mini-bubble-out">How about we meet at your selected stay dates?</article>
  <article class="mini-bubble mini-bubble-card">
    <section
      id="calendar-root"
      class="calendar-shell mini-calendar-shell"
      data-month="${escapeHtml(monthKey)}"
      data-token="${escapeHtml(token)}"
      data-hotel-id="${escapeHtml(hotel.id)}"
      data-guests="${guests}"
      data-rooms="${rooms}"
    ></section>
  </article>
</section>
<form id="select-form" method="post" action="/guest/calendar/select" class="calendar-form" style="display:grid; gap:8px; margin-top:12px">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <input type="hidden" name="hotelId" value="${escapeHtml(hotel.id)}" />
  <input type="hidden" name="month" value="${escapeHtml(monthKey)}" />
  <input type="hidden" name="checkIn" id="checkInInput" />
  <input type="hidden" name="checkOut" id="checkOutInput" />
  <input type="hidden" name="guests" value="${guests}" />
  <input type="hidden" name="rooms" value="${rooms}" />
  <input type="hidden" name="guestName" value="${escapeHtml(guestName)}" />
  <input type="hidden" name="phone" value="${escapeHtml(phone)}" />
  <div class="row">
    <label>Your name (optional)
      <input type="text" name="guestName" value="${escapeHtml(guestName)}" placeholder="Ahmed" />
    </label>
    <label>Your phone (optional)
      <input type="text" name="phone" value="${escapeHtml(phone)}" placeholder="9689XXXXXXX" />
    </label>
  </div>
  <p id="selectionText" class="selection-card muted">Select check-in and check-out dates.</p>
  <button type="submit" id="continueBtn" disabled>Continue to WhatsApp</button>
</form>`;
  res.type("html").send(guestLayout(content));
});

guestRouter.get("/calendar/availability", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  const hotelIdFromQuery = typeof req.query.hotelId === "string" ? req.query.hotelId.trim() : "";
  const guests = parseIntSafe(req.query.guests, 2, 1, 16);
  const rooms = parseIntSafe(req.query.rooms, 1, 1, 6);
  const monthStart = monthStartFromRaw(typeof req.query.month === "string" ? req.query.month.trim() : undefined);

  let hotelId = hotelIdFromQuery;
  if (token) {
    try {
      const session = await resolveCalendarSession(token);
      hotelId = session.hotelId;
    } catch {
      res.status(400).json({ error: "Invalid calendar token" });
      return;
    }
  }
  if (!hotelId) {
    const fallbackHotel = await prisma.hotel.findUnique({ where: { slug: defaultHotelSlug } });
    hotelId = fallbackHotel?.id ?? "";
  }
  if (!hotelId) {
    res.status(404).json({ error: "Hotel not found" });
    return;
  }

  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay());
  const days = await Promise.all(
    Array.from({ length: 42 }, async (_, idx) => {
      const date = addDays(gridStart, idx);
      const inMonth = date.getMonth() === monthStart.getMonth();
      if (!inMonth) {
        return { date: toIsoDate(date), day: date.getDate(), inMonth, available: false };
      }
      const availability = await getDayAvailability({ hotelId, date, guests, rooms });
      return {
        date: availability.date,
        day: date.getDate(),
        inMonth: true,
        available: availability.available,
        cheapestRate: availability.cheapestRate ?? null,
        reason: availability.reason ?? null
      };
    })
  );
  const monthLabel = monthStart.toLocaleString("en", { month: "long", year: "numeric" });
  res.json({ month: formatMonthKey(monthStart), monthLabel, days });
});

guestRouter.post("/calendar/select", async (req, res) => {
  const token = String(req.body.token ?? "").trim();
  const hotelIdBody = String(req.body.hotelId ?? "").trim();
  const guests = parseIntSafe(req.body.guests, 2, 1, 16);
  const rooms = parseIntSafe(req.body.rooms, 1, 1, 6);
  const guestName = String(req.body.guestName ?? "").trim();
  const phone = String(req.body.phone ?? "").trim();
  const checkInRaw = String(req.body.checkIn ?? "").trim();
  const checkOutRaw = String(req.body.checkOut ?? "").trim();
  const month = String(req.body.month ?? "").trim();

  let hotelId = hotelIdBody;
  let sessionGuestId: string | undefined;
  let sessionPhone = normalizePhone(phone);
  try {
    if (token) {
      const session = await resolveCalendarSession(token);
      hotelId = session.hotelId;
      sessionGuestId = session.guestId ?? undefined;
      if (!sessionPhone) sessionPhone = normalizePhone(session.phoneE164);
    }
  } catch (calendarError) {
    const message = calendarError instanceof Error ? calendarError.message : "Invalid calendar session";
    const query = new URLSearchParams({ hotelId, guests: String(guests), rooms: String(rooms), month, error: message });
    res.redirect(`/guest/calendar?${query.toString()}`);
    return;
  }

  const hotel = hotelId
    ? await prisma.hotel.findUnique({ where: { id: hotelId } })
    : await prisma.hotel.findUnique({ where: { slug: defaultHotelSlug } });
  if (!hotel) {
    res.redirect("/guest/calendar?error=Hotel+not+found");
    return;
  }

  const checkIn = new Date(checkInRaw);
  const checkOut = new Date(checkOutRaw);
  if (!checkInRaw || !checkOutRaw || Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime()) || checkOut <= checkIn) {
    const query = new URLSearchParams({
      hotelId: hotel.id,
      guests: String(guests),
      rooms: String(rooms),
      month,
      error: "Please select valid check-in and check-out dates."
    });
    if (token) query.set("token", token);
    if (phone) query.set("phone", phone);
    if (guestName) query.set("guestName", guestName);
    res.redirect(`/guest/calendar?${query.toString()}`);
    return;
  }

  const offer = await findAvailableRoomType({
    hotelId: hotel.id,
    checkIn,
    checkOut,
    guests,
    rooms
  });
  if (!offer) {
    const query = new URLSearchParams({
      hotelId: hotel.id,
      guests: String(guests),
      rooms: String(rooms),
      month,
      error: "Selected dates are no longer available. Please choose different dates."
    });
    if (token) query.set("token", token);
    if (phone) query.set("phone", phone);
    if (guestName) query.set("guestName", guestName);
    res.redirect(`/guest/calendar?${query.toString()}`);
    return;
  }

  const normalizedGuestPhone = sessionPhone || normalizePhone(phone);
  const guest =
    (sessionGuestId
      ? await prisma.guest.findUnique({ where: { id: sessionGuestId } })
      : normalizedGuestPhone
        ? await prisma.guest.upsert({
            where: { hotelId_phoneE164: { hotelId: hotel.id, phoneE164: normalizedGuestPhone } },
            update: { ...(guestName ? { fullName: guestName } : {}) },
            create: { hotelId: hotel.id, phoneE164: normalizedGuestPhone, ...(guestName ? { fullName: guestName } : {}) }
          })
        : null) ??
    null;

  let conversationId: string | undefined;
  if (guest) {
    const conversation =
      (await prisma.conversation.findFirst({
        where: { hotelId: hotel.id, guestId: guest.id, state: { in: ["NEW", "QUALIFYING", "QUOTED", "PAYMENT_PENDING", "CONFIRMED"] } },
        orderBy: { updatedAt: "desc" }
      })) ??
      (await prisma.conversation.create({
        data: { hotelId: hotel.id, guestId: guest.id, state: "QUALIFYING", lastMessageAt: new Date() }
      }));
    conversationId = conversation.id;

    await saveConversationSession({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId,
      phoneE164: guest.phoneE164,
      state: {
        language: guest.locale || "en",
        stage: "WAITING_CONFIRMATION",
        guestName: guestName || guest.fullName || undefined,
        checkIn: toIsoDate(checkIn),
        checkOut: toIsoDate(checkOut),
        guestCount: guests,
        roomCount: rooms,
        suggestedRoomTypeId: offer.roomTypeId,
        suggestedRoomTypeName: offer.roomTypeName,
        suggestedPropertyId: offer.propertyId,
        nightlyRate: offer.nightlyTotal,
        nights: offer.nights,
        totalAmount: offer.total
      },
      ttlMs: 60 * 60 * 1000
    });
    await upsertBookingDraft({
      hotelId: hotel.id,
      guestId: guest.id,
      conversationId,
      currency: hotel.currency,
      source: "WEB_CALENDAR",
      state: {
        language: guest.locale || "en",
        stage: "WAITING_CONFIRMATION",
        guestName: guestName || guest.fullName || undefined,
        checkIn: toIsoDate(checkIn),
        checkOut: toIsoDate(checkOut),
        guestCount: guests,
        roomCount: rooms,
        suggestedRoomTypeId: offer.roomTypeId,
        suggestedRoomTypeName: offer.roomTypeName,
        suggestedPropertyId: offer.propertyId,
        nightlyRate: offer.nightlyTotal,
        nights: offer.nights,
        totalAmount: offer.total
      }
    });
  }

  if (token) {
    const session = await resolveCalendarSession(token).catch(() => null);
    if (session) {
      await markCalendarSessionUsed(session.id);
    }
  }

  const summaryMessage = [
    `Great choice. I found availability for ${toIsoDate(checkIn)} to ${toIsoDate(checkOut)}.`,
    `Room: ${offer.roomTypeName}`,
    `Guests: ${guests} | Rooms: ${rooms}`,
    `Total: ${offer.total.toFixed(2)} ${hotel.currency}`,
    "Reply with YES to confirm or NO to edit."
  ].join("\n");
  if (guest) {
    const config = loadPartnerSetupConfig(hotel.id);
    try {
      await sendWhatsAppButtons({
        to: normalizePhone(guest.phoneE164),
        body: summaryMessage,
        buttons: [
          { id: "confirm_booking", title: "Confirm" },
          { id: "edit_booking", title: "Edit" }
        ],
        phoneNumberId: config.whatsappPhoneNumberId || undefined
      });
    } catch {
      await sendWhatsAppText({
        to: normalizePhone(guest.phoneE164),
        body: summaryMessage,
        phoneNumberId: config.whatsappPhoneNumberId || undefined
      });
    }
  }

  const waHotelPhone = normalizePhone(hotel.whatsappPhone ?? "");
  const waLink = waHotelPhone
    ? `https://wa.me/${encodeURIComponent(waHotelPhone)}?text=${encodeURIComponent(`I selected ${toIsoDate(checkIn)} to ${toIsoDate(checkOut)} for ${guests} guests and ${rooms} room${rooms > 1 ? "s" : ""}.`)}` 
    : "";
  const content = `
<h1>Dates Selected</h1>
<p class="muted">Your calendar selection is saved. Continue in WhatsApp to confirm.</p>
<table>
  <tbody>
    <tr><th>Hotel</th><td>${escapeHtml(hotel.displayName)}</td></tr>
    <tr><th>Check-in</th><td>${escapeHtml(toIsoDate(checkIn))}</td></tr>
    <tr><th>Check-out</th><td>${escapeHtml(toIsoDate(checkOut))}</td></tr>
    <tr><th>Room</th><td>${escapeHtml(offer.roomTypeName)}</td></tr>
    <tr><th>Total</th><td>${offer.total.toFixed(2)} ${escapeHtml(hotel.currency)}</td></tr>
  </tbody>
</table>
${waLink
    ? `<p style="margin-top:12px"><a href="${waLink}" style="display:inline-block; padding:10px 14px; border-radius:8px; background:#0b6e6e; color:#fff; text-decoration:none; font-weight:700">Open WhatsApp</a></p>`
    : `<p class="badge pending">Hotel WhatsApp number is not configured. Please continue in your existing WhatsApp chat.</p>`}
<p><a href="/guest/calendar?hotelId=${encodeURIComponent(hotel.id)}${token ? `&token=${encodeURIComponent(token)}` : ""}">Back to calendar</a></p>`;
  res.type("html").send(guestLayout(content));
});

