import { BookingStatus, ConversationState, MessageDirection, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { loadPartnerSetupConfig } from "../core/partnerSetup";
import { sendWhatsAppButtons, trySendWhatsAppText } from "../whatsapp/send";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** Quiet hours start (24h clock, inclusive), default 22 = 10 PM hotel local. */
const QUIET_HOURS_START = Math.min(23, Math.max(0, parseInt(process.env.QUIET_HOURS_START ?? "22", 10) || 22));
/** Quiet hours end (24h clock, exclusive until this hour), default 8 = 8 AM hotel local. */
const QUIET_HOURS_END = Math.min(23, Math.max(0, parseInt(process.env.QUIET_HOURS_END ?? "8", 10) || 8));
/** Default civil hour when shifting sends out of quiet hours, default 9 = 9 AM. */
const DEFAULT_SEND_HOUR = Math.min(22, Math.max(0, parseInt(process.env.DEFAULT_SEND_HOUR ?? "9", 10) || 9));

export type GuestJourneySendWindowReason = "none" | "early_morning" | "late_night";

export function hotelTimezoneOrUtc(hotelTimezone: string | null | undefined): string {
  const t = (hotelTimezone ?? "").trim();
  return t || "UTC";
}

function ymdAddCalendarDays(ymd: string, deltaDays: number): string {
  const [y, mo, d] = ymd.split("-").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return ymd;
  const u = new Date(Date.UTC(y, mo - 1, d + deltaDays));
  return `${u.getUTCFullYear()}-${String(u.getUTCMonth() + 1).padStart(2, "0")}-${String(u.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Shift a desired send instant into an allowed daytime window in `timeZone` (hotel local).
 * Quiet: [QUIET_HOURS_START, 24) ∪ [0, QUIET_HOURS_END) — no sends overnight.
 * - If local time falls before QUIET_HOURS_END → same calendar day at DEFAULT_SEND_HOUR:00.
 * - If at or after QUIET_HOURS_START → next calendar day at DEFAULT_SEND_HOUR:00.
 * `desiredSendUtc` is typically checkout wall + offsets (e.g. +24h for thank-you).
 */
export function getSafeSendTime(desiredSendUtc: Date, timeZone: string): {
  originalUtc: Date;
  adjustedUtc: Date;
  reason: GuestJourneySendWindowReason;
} {
  const tz = hotelTimezoneOrUtc(timeZone);
  const originalUtc = desiredSendUtc;
  if (Number.isNaN(originalUtc.getTime())) {
    return { originalUtc, adjustedUtc: originalUtc, reason: "none" };
  }

  const quietStartMin = QUIET_HOURS_START * 60;
  const quietEndMin = QUIET_HOURS_END * 60;
  const { ymd, minOfDay } = readWallClockInZone(originalUtc, tz);
  const inQuiet = minOfDay >= quietStartMin || minOfDay < quietEndMin;

  if (!inQuiet) {
    return { originalUtc, adjustedUtc: originalUtc, reason: "none" };
  }

  const hm = `${String(DEFAULT_SEND_HOUR).padStart(2, "0")}:00`;

  if (minOfDay < quietEndMin) {
    const adjustedUtc = wallClockLocalToUtc(ymd, hm, tz);
    if (Number.isNaN(adjustedUtc.getTime())) {
      return { originalUtc, adjustedUtc: originalUtc, reason: "none" };
    }
    return { originalUtc, adjustedUtc, reason: "early_morning" };
  }

  const nextYmd = ymdAddCalendarDays(ymd, 1);
  const adjustedUtc = wallClockLocalToUtc(nextYmd, hm, tz);
  if (Number.isNaN(adjustedUtc.getTime())) {
    return { originalUtc, adjustedUtc: originalUtc, reason: "none" };
  }
  return { originalUtc, adjustedUtc, reason: "late_night" };
}

function envHoursToMs(envKey: string, defaultHours: number): number {
  const h = parseInt(process.env[envKey] ?? String(defaultHours), 10);
  const hours = Number.isFinite(h) && h >= 0 ? h : defaultHours;
  return hours * 60 * 60 * 1000;
}

function envDaysToMs(envKey: string, defaultDays: number): number {
  const d = parseInt(process.env[envKey] ?? String(defaultDays), 10);
  const days = Number.isFinite(d) && d >= 0 ? d : defaultDays;
  return days * 24 * 60 * 60 * 1000;
}

async function countCompletedStaysAtHotel(guestId: string, hotelId: string, asOf: Date): Promise<number> {
  return prisma.booking.count({
    where: {
      guestId,
      hotelId,
      status: BookingStatus.CONFIRMED,
      checkOut: { lte: asOf }
    }
  });
}

export type GuestJourneySweepResult = {
  scanned: number;
  sentPreArrival24h: number;
  sentCheckinDay: number;
  sentPostCheckout: number;
  sentReviewRequest: number;
  sentReviewReminder: number;
  sentRepeatGuestPromo: number;
  skipped: number;
};

/** Interpret YYYY-MM-DD + HH:MM as civil time in `timeZone` and return the corresponding UTC instant. */
export function wallClockLocalToUtc(ymd: string, hm: string, timeZone: string): Date {
  const [y, mo, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const [hh, mm] = hm.split(":").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d) || !Number.isFinite(hh) || !Number.isFinite(mm)) {
    return new Date(NaN);
  }
  const wantMin = hh * 60 + mm;
  const start = Date.UTC(y, mo - 1, d, 0, 0, 0, 0) - 18 * 3600000;
  const end = start + 72 * 3600000;
  for (let t = start; t < end; t += 60 * 1000) {
    const { ymd: cy, minOfDay } = readWallClockInZone(new Date(t), timeZone);
    if (cy === ymd && minOfDay === wantMin) return new Date(t);
  }
  return new Date(NaN);
}

export function readWallClockInZone(d: Date, timeZone: string): { ymd: string; minOfDay: number } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const p = f.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === type)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  const h = parseInt(get("hour"), 10);
  const m = parseInt(get("minute"), 10);
  return { ymd, minOfDay: h * 60 + m };
}

export function formatYmdInHotelZone(iso: Date, hotelTimezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: hotelTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(iso);
}

export function parseCheckInHm(propertyCheckInTime: string | null | undefined): string {
  const raw = (propertyCheckInTime ?? "").trim();
  if (!raw) return "14:00";
  const m24 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = Math.min(23, Math.max(0, parseInt(m24[1], 10)));
    const min = Math.min(59, Math.max(0, parseInt(m24[2], 10)));
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  return "14:00";
}

export function parseCheckOutHm(propertyCheckOutTime: string | null | undefined): string {
  const raw = (propertyCheckOutTime ?? "").trim();
  if (!raw) return "11:00";
  const m24 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = Math.min(23, Math.max(0, parseInt(m24[1], 10)));
    const min = Math.min(59, Math.max(0, parseInt(m24[2], 10)));
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  return "11:00";
}

function firstName(fullName: string | null | undefined): string {
  if (!fullName?.trim()) return "";
  const parts = fullName.trim().split(/\s+/);
  return parts[0] ?? "";
}

function buildPreArrival24hBody(params: { guestFirstName: string; hotelName: string; arrivalSummary: string }): string {
  const who = params.guestFirstName.trim() || "Guest";
  return [
    `Hello ${who},`,
    "",
    `We look forward to welcoming you tomorrow at ${params.hotelName}. Your arrival is planned for ${params.arrivalSummary}.`,
    "",
    "If you have an estimated time of arrival, special requests, or need directions or assistance before you arrive, simply reply to this message and our team will be glad to help.",
    "",
    `— ${params.hotelName}`
  ].join("\n");
}

function buildCheckinDayBody(params: { guestFirstName: string; hotelName: string; arrivalSummary: string }): string {
  const who = params.guestFirstName.trim() || "Guest";
  return [
    `Good morning ${who},`,
    "",
    `Today is your arrival day at ${params.hotelName}. We look forward to welcoming you — your check-in is scheduled for ${params.arrivalSummary}.`,
    "",
    "When you are on your way or if you need anything (parking, luggage, late arrival), reply here and we will coordinate with you.",
    "",
    `— ${params.hotelName}`
  ].join("\n");
}

function buildPostCheckoutBody(params: { guestFirstName: string; hotelName: string }): string {
  const who = params.guestFirstName.trim() || "Guest";
  return [
    `Dear ${who},`,
    "",
    `Thank you for staying with ${params.hotelName}. We hope you enjoyed your time with us and travelled safely onward.`,
    "",
    "We would be delighted to welcome you again. If you have a moment to share feedback or wish to plan a future visit, you can reply to this message.",
    "",
    `Warm regards,`,
    params.hotelName
  ].join("\n");
}

function buildReviewRequestBody(params: { guestFirstName: string; hotelName: string }): string {
  const who = params.guestFirstName.trim() || "Guest";
  return [
    `Hi ${who}, we hope you enjoyed your stay at ${params.hotelName}.`,
    "",
    "We would love your feedback. How would you rate your experience?"
  ].join("\n");
}

const FEEDBACK_RATING_BUTTONS: Array<{ id: string; title: string }> = [
  { id: "fb_rate_5", title: "⭐⭐⭐⭐⭐ Excellent" },
  { id: "fb_rate_4", title: "⭐⭐⭐⭐ Good" },
  { id: "fb_rate_3", title: "⭐⭐⭐ Average" },
  { id: "fb_rate_2", title: "⭐⭐ Poor" },
  { id: "fb_rate_1", title: "⭐ Very poor" }
];

function buildRepeatGuestPromoBody(params: { guestFirstName: string; hotelName: string }): string {
  const who = params.guestFirstName.trim() || "Guest";
  return [
    `Dear ${who},`,
    "",
    `It was a pleasure welcoming you back to ${params.hotelName}. Thank you for choosing us again.`,
    "",
    "When you next plan a visit, we would be delighted to host you. Reply to this message for availability or to hear about any current return-stay offers we may extend to valued guests.",
    "",
    `Kind regards,`,
    params.hotelName
  ].join("\n");
}

function formatArrivalSummary(scheduledArrival: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).format(scheduledArrival);
}

type BookingWithGuestProperty = Prisma.BookingGetPayload<{
  include: { guest: true; property: { select: { checkInTime: true; checkOutTime: true } } };
}>;

async function getOrCreateConversation(hotelId: string, guestId: string): Promise<{ id: string }> {
  const existing = await prisma.conversation.findFirst({
    where: { hotelId, guestId },
    orderBy: { updatedAt: "desc" },
    select: { id: true }
  });
  if (existing) return existing;
  return prisma.conversation.create({
    data: {
      hotelId,
      guestId,
      state: ConversationState.NEW,
      channel: "WHATSAPP",
      lastMessageAt: new Date()
    },
    select: { id: true }
  });
}

type JourneyAiIntent =
  | "PRE_ARRIVAL_24H"
  | "CHECKIN_DAY"
  | "POST_CHECKOUT_THANK_YOU"
  | "REVIEW_REQUEST"
  | "REPEAT_GUEST_PROMO";

async function sendJourneyMessage(params: {
  hotelId: string;
  phoneNumberId: string;
  booking: BookingWithGuestProperty;
  body: string;
  aiIntent: JourneyAiIntent;
  markSent: Prisma.BookingUpdateInput;
  auditAction: string;
  /** Optional guest update (e.g. repeat-promo cooldown timestamp). Applied in the same transaction as the booking update. */
  guestUpdate?: { guestId: string; data: Prisma.GuestUpdateInput };
  buttons?: Array<{ id: string; title: string }>;
}): Promise<boolean> {
  const phone = params.booking.guest.phoneE164?.trim();
  if (!phone) return false;

  const conversation = await getOrCreateConversation(params.hotelId, params.booking.guestId);
  if (!params.booking.conversationId) {
    await prisma.booking.update({
      where: { id: params.booking.id },
      data: { conversationId: conversation.id }
    });
  }

  if (params.buttons?.length) {
    try {
      await sendWhatsAppButtons({
        to: phone,
        body: params.body,
        buttons: params.buttons,
        phoneNumberId: params.phoneNumberId,
        conversationId: conversation.id
      });
    } catch (err) {
      const fallback = await trySendWhatsAppText({
        to: phone,
        body: `${params.body}\n\nReply with 1, 2, 3, 4, or 5 stars.`,
        phoneNumberId: params.phoneNumberId,
        conversationId: conversation.id
      });
      if (!fallback.ok) {
        const msg = err instanceof Error ? err.message : fallback.errorMessage;
        console.error(`[guest-journey] send failed booking=${params.booking.id} intent=${params.aiIntent}: ${msg.slice(0, 220)}`);
        return false;
      }
    }
  } else {
    const result = await trySendWhatsAppText({
      to: phone,
      body: params.body,
      phoneNumberId: params.phoneNumberId,
      conversationId: conversation.id
    });
    if (!result.ok) {
      console.error(
        `[guest-journey] send failed booking=${params.booking.id} intent=${params.aiIntent}: ${result.errorMessage.slice(0, 220)}`
      );
      return false;
    }
  }

  const sentAt = new Date();
  const tx: Prisma.PrismaPromise<unknown>[] = [
    prisma.booking.update({
      where: { id: params.booking.id },
      data: params.markSent
    }),
    prisma.message.create({
      data: {
        hotelId: params.hotelId,
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        body: params.body,
        aiIntent: params.aiIntent,
        aiConfidence: 1
      }
    }),
    prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: sentAt, updatedAt: sentAt }
    }),
    prisma.auditLog.create({
      data: {
        hotelId: params.hotelId,
        action: params.auditAction,
        entityType: "Booking",
        entityId: params.booking.id,
        bookingId: params.booking.id,
        metadataJson: JSON.stringify({ guestId: params.booking.guestId, conversationId: conversation.id, aiIntent: params.aiIntent })
      }
    })
  ];
  if (params.guestUpdate) {
    tx.push(
      prisma.guest.update({
        where: { id: params.guestUpdate.guestId },
        data: params.guestUpdate.data
      })
    );
  }
  await prisma.$transaction(tx);

  return true;
}

/**
 * Automated guest journey WhatsApp: 24h pre-arrival, same-day check-in, post-checkout thank-you,
 * review request (after thank-you + delay), repeat-guest promo (eligible guests only, guest-level cooldown).
 *
 * Post-stay timing: thank-you is **earliest** at scheduled checkout (property local wall) **+ 24h**, then
 * shifted into **quiet-safe** daytime (see `getSafeSendTime`, env `QUIET_HOURS_*` / `DEFAULT_SEND_HOUR`).
 * Same window logic applies to review, reminder, and repeat-promo sends.
 *
 * Each type sends at most once per booking (tracked on Booking; repeat promo also uses Guest.journeyLastRepeatPromoAt).
 * Failed WhatsApp sends do not mark sent (retry next sweep).
 */
export async function runGuestJourneyMessagingSweep(): Promise<GuestJourneySweepResult> {
  let scanned = 0;
  let sentPreArrival24h = 0;
  let sentCheckinDay = 0;
  let sentPostCheckout = 0;
  let sentReviewRequest = 0;
  let sentReviewReminder = 0;
  let sentRepeatGuestPromo = 0;
  let skipped = 0;

  const reviewDelayMs = envHoursToMs("GUEST_JOURNEY_REVIEW_DELAY_HOURS", 48);
  const repeatPromoDelayMs = envHoursToMs("GUEST_JOURNEY_REPEAT_PROMO_DELAY_HOURS", 72);
  const repeatPromoCooldownMs = envDaysToMs("GUEST_JOURNEY_REPEAT_PROMO_COOLDOWN_DAYS", 90);

  const hotels = await prisma.hotel.findMany({
    where: { isActive: true },
    select: { id: true, displayName: true, timezone: true }
  });

  const now = new Date();

  for (const hotel of hotels) {
    const partner = loadPartnerSetupConfig(hotel.id);
    const phoneNumberId = partner.whatsappPhoneNumberId?.trim() || process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    if (!phoneNumberId) continue;

    const tz = hotelTimezoneOrUtc(hotel.timezone);
    const todayYmd = formatYmdInHotelZone(now, tz);

    const baseInclude = {
      guest: true,
      property: { select: { checkInTime: true, checkOutTime: true } }
    };

    // --- PRE_ARRIVAL_24H ---
    const for24h = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        status: BookingStatus.CONFIRMED,
        guestJourneyPreArrival24hSentAt: null,
        preArrivalReminderSentAt: null
      },
      include: baseInclude
    });

    for (const b of for24h) {
      scanned++;
      const ymdIn = formatYmdInHotelZone(b.checkIn, tz);
      const hm = parseCheckInHm(b.property.checkInTime);
      const scheduledArrival = wallClockLocalToUtc(ymdIn, hm, tz);
      if (Number.isNaN(scheduledArrival.getTime())) {
        skipped++;
        continue;
      }
      const windowStart = new Date(scheduledArrival.getTime() - TWENTY_FOUR_HOURS_MS);
      if (now < windowStart || now.getTime() >= scheduledArrival.getTime()) {
        skipped++;
        continue;
      }

      const arrivalSummary = formatArrivalSummary(scheduledArrival, tz);
      const body = buildPreArrival24hBody({
        guestFirstName: firstName(b.guest.fullName),
        hotelName: hotel.displayName,
        arrivalSummary
      });

      const ok = await sendJourneyMessage({
        hotelId: hotel.id,
        phoneNumberId,
        booking: b,
        body,
        aiIntent: "PRE_ARRIVAL_24H",
        markSent: { guestJourneyPreArrival24hSentAt: new Date() },
        auditAction: "GUEST_JOURNEY_PRE_ARRIVAL_24H_SENT"
      });
      if (ok) sentPreArrival24h++;
      else skipped++;
    }

    // --- CHECKIN_DAY ---
    const forCheckinDay = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        status: BookingStatus.CONFIRMED,
        guestJourneyCheckinDaySentAt: null
      },
      include: baseInclude
    });

    for (const b of forCheckinDay) {
      scanned++;
      const checkInYmd = formatYmdInHotelZone(b.checkIn, tz);
      if (checkInYmd !== todayYmd) {
        skipped++;
        continue;
      }
      const hm = parseCheckInHm(b.property.checkInTime);
      const scheduledArrival = wallClockLocalToUtc(checkInYmd, hm, tz);
      if (Number.isNaN(scheduledArrival.getTime())) {
        skipped++;
        continue;
      }
      const graceEnd = new Date(scheduledArrival.getTime() + 12 * 60 * 60 * 1000);
      if (now.getTime() > graceEnd.getTime()) {
        skipped++;
        continue;
      }

      const arrivalSummary = formatArrivalSummary(scheduledArrival, tz);
      const body = buildCheckinDayBody({
        guestFirstName: firstName(b.guest.fullName),
        hotelName: hotel.displayName,
        arrivalSummary
      });

      const ok = await sendJourneyMessage({
        hotelId: hotel.id,
        phoneNumberId,
        booking: b,
        body,
        aiIntent: "CHECKIN_DAY",
        markSent: { guestJourneyCheckinDaySentAt: new Date() },
        auditAction: "GUEST_JOURNEY_CHECKIN_DAY_SENT"
      });
      if (ok) sentCheckinDay++;
      else skipped++;
    }

    // --- POST_CHECKOUT_THANK_YOU ---
    const forPostCheckout = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        status: BookingStatus.CONFIRMED,
        guestJourneyPostCheckoutThankYouSentAt: null,
        checkOut: { lte: now }
      },
      include: baseInclude
    });

    for (const b of forPostCheckout) {
      scanned++;
      const checkoutYmd = formatYmdInHotelZone(b.checkOut, tz);
      const hmOut = parseCheckOutHm(b.property.checkOutTime);
      const scheduledDeparture = wallClockLocalToUtc(checkoutYmd, hmOut, tz);
      if (Number.isNaN(scheduledDeparture.getTime())) {
        skipped++;
        continue;
      }

      const thankYouBaseUtc = new Date(scheduledDeparture.getTime() + TWENTY_FOUR_HOURS_MS);
      const thankYouWindow = getSafeSendTime(thankYouBaseUtc, tz);
      if (now.getTime() < thankYouWindow.adjustedUtc.getTime()) {
        skipped++;
        continue;
      }
      if (thankYouWindow.reason !== "none") {
        console.info(
          "[guest-journey] POST_CHECKOUT_THANK_YOU send-window",
          JSON.stringify({
            bookingId: b.id,
            originalSendTime: thankYouWindow.originalUtc.toISOString(),
            adjustedSendTime: thankYouWindow.adjustedUtc.toISOString(),
            reason: thankYouWindow.reason
          })
        );
      }

      const body = buildPostCheckoutBody({
        guestFirstName: firstName(b.guest.fullName),
        hotelName: hotel.displayName
      });

      const ok = await sendJourneyMessage({
        hotelId: hotel.id,
        phoneNumberId,
        booking: b,
        body,
        aiIntent: "POST_CHECKOUT_THANK_YOU",
        markSent: { guestJourneyPostCheckoutThankYouSentAt: new Date() },
        auditAction: "GUEST_JOURNEY_POST_CHECKOUT_SENT"
      });
      if (ok) sentPostCheckout++;
      else skipped++;
    }

    // --- REVIEW_REQUEST (after post-checkout thank-you + delay from scheduled departure) ---
    const forReview = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        status: BookingStatus.CONFIRMED,
        guestJourneyReviewRequestSentAt: null,
        guestJourneyPostCheckoutThankYouSentAt: { not: null }
      },
      include: baseInclude
    });

    for (const b of forReview) {
      scanned++;
      const checkoutYmd = formatYmdInHotelZone(b.checkOut, tz);
      const hmOut = parseCheckOutHm(b.property.checkOutTime);
      const scheduledDeparture = wallClockLocalToUtc(checkoutYmd, hmOut, tz);
      if (Number.isNaN(scheduledDeparture.getTime())) {
        skipped++;
        continue;
      }
      const reviewDesiredUtc = new Date(scheduledDeparture.getTime() + reviewDelayMs);
      const reviewWindow = getSafeSendTime(reviewDesiredUtc, tz);
      if (now.getTime() < reviewWindow.adjustedUtc.getTime()) {
        skipped++;
        continue;
      }
      if (reviewWindow.reason !== "none") {
        console.info(
          "[guest-journey] REVIEW_REQUEST send-window",
          JSON.stringify({
            bookingId: b.id,
            originalSendTime: reviewWindow.originalUtc.toISOString(),
            adjustedSendTime: reviewWindow.adjustedUtc.toISOString(),
            reason: reviewWindow.reason
          })
        );
      }

      const body = buildReviewRequestBody({
        guestFirstName: firstName(b.guest.fullName),
        hotelName: hotel.displayName
      });

      const ok = await sendJourneyMessage({
        hotelId: hotel.id,
        phoneNumberId,
        booking: b,
        body,
        aiIntent: "REVIEW_REQUEST",
        markSent: { guestJourneyReviewRequestSentAt: new Date() },
        auditAction: "GUEST_JOURNEY_REVIEW_REQUEST_SENT",
        buttons: FEEDBACK_RATING_BUTTONS
      });
      if (ok) sentReviewRequest++;
      else skipped++;
    }

    // --- REVIEW_REQUEST_REMINDER (once, 24h after review request, only when no feedback yet) ---
    const forReviewReminder = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        status: BookingStatus.CONFIRMED,
        guestJourneyReviewRequestSentAt: { not: null },
        guestJourneyReviewReminderSentAt: null,
        guestJourneyPostCheckoutThankYouSentAt: { not: null },
        feedbacks: { none: {} }
      },
      include: baseInclude
    });

    for (const b of forReviewReminder) {
      scanned++;
      const reviewSentAt = b.guestJourneyReviewRequestSentAt;
      if (!reviewSentAt) {
        skipped++;
        continue;
      }
      const reminderDesiredUtc = new Date(reviewSentAt.getTime() + 24 * 60 * 60 * 1000);
      const reminderWindow = getSafeSendTime(reminderDesiredUtc, tz);
      if (now.getTime() < reminderWindow.adjustedUtc.getTime()) {
        skipped++;
        continue;
      }
      if (reminderWindow.reason !== "none") {
        console.info(
          "[guest-journey] REVIEW_REQUEST_REMINDER send-window",
          JSON.stringify({
            bookingId: b.id,
            originalSendTime: reminderWindow.originalUtc.toISOString(),
            adjustedSendTime: reminderWindow.adjustedUtc.toISOString(),
            reason: reminderWindow.reason
          })
        );
      }
      const body = `${buildReviewRequestBody({
        guestFirstName: firstName(b.guest.fullName),
        hotelName: hotel.displayName
      })}\n\nJust a quick reminder — we value your feedback.`;
      const ok = await sendJourneyMessage({
        hotelId: hotel.id,
        phoneNumberId,
        booking: b,
        body,
        aiIntent: "REVIEW_REQUEST",
        markSent: { guestJourneyReviewReminderSentAt: new Date() },
        auditAction: "GUEST_JOURNEY_REVIEW_REQUEST_REMINDER_SENT",
        buttons: FEEDBACK_RATING_BUTTONS
      });
      if (ok) sentReviewReminder++;
      else skipped++;
    }

    // --- REPEAT_GUEST_PROMO (2+ completed stays at hotel, cooldown, once per booking + one per sweep per guest) ---
    const repeatPromoGuestDone = new Set<string>();
    const forRepeatPromo = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        status: BookingStatus.CONFIRMED,
        guestJourneyRepeatPromoSentAt: null,
        guestJourneyPostCheckoutThankYouSentAt: { not: null }
      },
      include: baseInclude
    });

    for (const b of forRepeatPromo) {
      scanned++;
      if (repeatPromoGuestDone.has(b.guestId)) {
        skipped++;
        continue;
      }
      const checkoutYmd = formatYmdInHotelZone(b.checkOut, tz);
      const hmOut = parseCheckOutHm(b.property.checkOutTime);
      const scheduledDeparture = wallClockLocalToUtc(checkoutYmd, hmOut, tz);
      if (Number.isNaN(scheduledDeparture.getTime())) {
        skipped++;
        continue;
      }
      const promoDesiredUtc = new Date(scheduledDeparture.getTime() + repeatPromoDelayMs);
      const promoWindow = getSafeSendTime(promoDesiredUtc, tz);
      if (now.getTime() < promoWindow.adjustedUtc.getTime()) {
        skipped++;
        continue;
      }
      if (promoWindow.reason !== "none") {
        console.info(
          "[guest-journey] REPEAT_GUEST_PROMO send-window",
          JSON.stringify({
            bookingId: b.id,
            originalSendTime: promoWindow.originalUtc.toISOString(),
            adjustedSendTime: promoWindow.adjustedUtc.toISOString(),
            reason: promoWindow.reason
          })
        );
      }

      const lastPromo = b.guest.journeyLastRepeatPromoAt;
      if (lastPromo && now.getTime() - lastPromo.getTime() < repeatPromoCooldownMs) {
        skipped++;
        continue;
      }

      const completedCount = await countCompletedStaysAtHotel(b.guestId, hotel.id, now);
      if (completedCount < 2) {
        skipped++;
        continue;
      }

      const promoAt = new Date();
      const body = buildRepeatGuestPromoBody({
        guestFirstName: firstName(b.guest.fullName),
        hotelName: hotel.displayName
      });

      const ok = await sendJourneyMessage({
        hotelId: hotel.id,
        phoneNumberId,
        booking: b,
        body,
        aiIntent: "REPEAT_GUEST_PROMO",
        markSent: { guestJourneyRepeatPromoSentAt: promoAt },
        auditAction: "GUEST_JOURNEY_REPEAT_PROMO_SENT",
        guestUpdate: {
          guestId: b.guestId,
          data: { journeyLastRepeatPromoAt: promoAt }
        }
      });
      if (ok) {
        sentRepeatGuestPromo++;
        repeatPromoGuestDone.add(b.guestId);
      } else {
        skipped++;
      }
    }
  }

  return {
    scanned,
    sentPreArrival24h,
    sentCheckinDay,
    sentPostCheckout,
    sentReviewRequest,
    sentReviewReminder,
    sentRepeatGuestPromo,
    skipped
  };
}

/** @deprecated Use runGuestJourneyMessagingSweep */
export async function runPreArrivalReminderSweep(): Promise<{
  scanned: number;
  sent: number;
  skipped: number;
}> {
  const r = await runGuestJourneyMessagingSweep();
  return {
    scanned: r.scanned,
    sent:
      r.sentPreArrival24h +
      r.sentCheckinDay +
      r.sentPostCheckout +
      r.sentReviewRequest +
      r.sentReviewReminder +
      r.sentRepeatGuestPromo,
    skipped: r.skipped
  };
}

export function startPreArrivalReminderScheduler(): NodeJS.Timeout {
  const intervalMs = Math.max(
    60_000,
    parseInt(
      process.env.GUEST_JOURNEY_MESSAGING_INTERVAL_MS ??
        process.env.PRE_ARRIVAL_REMINDER_INTERVAL_MS ??
        "600000",
      10
    ) || 600_000
  );
  const run = () => {
    runGuestJourneyMessagingSweep().catch((err) =>
      console.error("[guest-journey] sweep failed:", err instanceof Error ? err.message : String(err))
    );
  };
  run();
  return setInterval(run, intervalMs);
}
