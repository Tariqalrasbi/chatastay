import { BookingStatus, ConversationState, MessageDirection, PaymentStatus, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { loadPartnerSetupConfig } from "../core/partnerSetup";
import {
  evaluateLifecycleMarketingEligibility,
  getLifecycleSendWindow,
  hasRecentOutboundJourneyIntents,
  inferGuestMessageSegment,
  logLifecycleScheduleDecision,
  type GuestMessageSegment
} from "../core/guestMessagingLifecycle";
import {
  formatYmdInHotelZone,
  getSafeSendTime,
  hotelTimezoneOrUtc,
  readWallClockInZone,
  wallClockLocalToUtc,
  type GuestJourneySendWindowReason
} from "../core/guestMessagingSchedule";
import { parseLightGuestMemory } from "../core/lightGuestMemory";
import { isGuestEffectivelyCheckedIn } from "../core/guestStayPresence";
import { englishDayPeriodGreetingLine } from "../core/timeGreetings";
import { sendWhatsAppButtons, sendWhatsAppList, trySendWhatsAppText } from "../whatsapp/send";
// Reuse the canonical guest-document sender so the cron, the front-desk button, manual buttons,
// and payment webhooks all share one PDF-build / dispatch / audit code path. No duplication.
import { sendInvoicePdfForBooking } from "../routes/admin";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const FINAL_INVOICE_AUDIT_ACTION = "BOOKING_INVOICE_PDF_SENT";

/**
 * Has a final invoice/folio document already been delivered to the guest for this booking?
 * Used both to gate the post-stay thank-you (must come AFTER the invoice) and to dedupe the
 * automatic final-invoice pass below.
 */
async function hasFinalInvoiceBeenSent(bookingId: string): Promise<boolean> {
  const row = await prisma.auditLog.findFirst({
    where: { action: FINAL_INVOICE_AUDIT_ACTION, entityType: "Booking", entityId: bookingId },
    select: { id: true }
  });
  return Boolean(row);
}

/** Re-export for callers that historically imported time helpers from this job module. */
export {
  formatYmdInHotelZone,
  getSafeSendTime,
  hotelTimezoneOrUtc,
  readWallClockInZone,
  wallClockLocalToUtc,
  type GuestJourneySendWindowReason
} from "../core/guestMessagingSchedule";

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
  /** Final invoice PDFs auto-sent because checkout date has passed. */
  sentFinalInvoice: number;
  skipped: number;
};

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
    "If you have an estimated time of arrival, special requests, or need directions before you arrive, simply reply to this message and our team will be glad to help.",
    "",
    "Reply *MENU* anytime to return to the main menu.",
    "",
    `— ${params.hotelName}`
  ].join("\n");
}

function buildCheckinDayBody(params: {
  guestFirstName: string;
  hotelName: string;
  arrivalSummary: string;
  hotelTimeZone?: string | null;
  now?: Date;
}): string {
  const who = params.guestFirstName.trim() || "Guest";
  const greet = englishDayPeriodGreetingLine(params.now ?? new Date(), params.hotelTimeZone);
  return [
    `${greet}, ${who},`,
    "",
    `Today is your arrival day at ${params.hotelName}. We look forward to welcoming you — your check-in is scheduled for ${params.arrivalSummary}.`,
    "",
    "When you are on your way or if you need anything (luggage, late arrival, directions), reply here and we will coordinate with you.",
    "",
    "Reply *MENU* anytime to return to the main menu.",
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
  const who = params.guestFirstName.trim() || "there";
  return [
    `Hi ${who},`,
    `Thank you for staying with us at ${params.hotelName}.`,
    "",
    "When you have a moment, how would you rate your stay overall? One tap below is enough."
  ].join("\n");
}

/** WhatsApp allows max 3 reply buttons — use a list so all five ratings are one tap each (mobile-friendly). */
const FEEDBACK_RATING_LIST = {
  buttonText: "Rate my stay",
  sections: [
    {
      title: "Your overall stay",
      rows: [
        { id: "fb_rate_5", title: "Excellent — 5 stars", description: "Exceeded expectations" },
        { id: "fb_rate_4", title: "Very good — 4 stars", description: "Happy overall" },
        { id: "fb_rate_3", title: "It was okay — 3 stars", description: "Mixed experience" },
        { id: "fb_rate_2", title: "Disappointed — 2 stars", description: "Below expectations" },
        { id: "fb_rate_1", title: "Very poor — 1 star", description: "Needs urgent care" }
      ]
    }
  ]
};

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
  include: {
    guest: { include: { segmentTags: { select: { tag: true } } } };
    property: { select: { checkInTime: true; checkOutTime: true } };
  };
}>;

function segmentForLifecycleBooking(b: BookingWithGuestProperty): GuestMessageSegment {
  const mem = parseLightGuestMemory(b.guest.lightGuestMemoryJson ?? null);
  const segmentTags = b.guest.segmentTags.map((t) => t.tag);
  return inferGuestMessageSegment({
    isVip: b.guest.isVip,
    segmentTags,
    children: b.children,
    adults: b.adults,
    nights: b.nights,
    checkIn: b.checkIn,
    memory: { repeatGuest: mem.repeatGuest, spendingLevel: mem.spendingLevel }
  });
}

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
  /** Prefer over `buttons` when more than three choices (e.g. five-star scale). */
  feedbackRatingList?: {
    buttonText: string;
    sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
  };
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

  if (params.feedbackRatingList) {
    try {
      await sendWhatsAppList({
        to: phone,
        body: params.body,
        buttonText: params.feedbackRatingList.buttonText,
        sections: params.feedbackRatingList.sections.map((s) => ({
          title: s.title,
          rows: s.rows.map((r) => ({
            id: r.id,
            title: r.title,
            ...(r.description ? { description: r.description } : {})
          }))
        })),
        phoneNumberId: params.phoneNumberId,
        conversationId: conversation.id
      });
    } catch (err) {
      const fallback = await trySendWhatsAppText({
        to: phone,
        body: `${params.body}\n\nReply 1 to 5 (5 = excellent, 1 = very poor).`,
        phoneNumberId: params.phoneNumberId,
        conversationId: conversation.id
      });
      if (!fallback.ok) {
        const msg = err instanceof Error ? err.message : fallback.errorMessage;
        console.error(`[guest-journey] send failed booking=${params.booking.id} intent=${params.aiIntent}: ${msg.slice(0, 220)}`);
        return false;
      }
    }
  } else if (params.buttons?.length) {
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
 * shifted into **quiet-safe** daytime (`guestMessagingSchedule.getSafeSendTime`, env `QUIET_HOURS_*` / `DEFAULT_SEND_HOUR`),
 * then **segment-aware** preferred slots (`guestMessagingLifecycle.getLifecycleSendWindow`: VIP / family / business / default).
 * Review waits at least `GUEST_JOURNEY_MIN_HOURS_AFTER_THANK_YOU_BEFORE_REVIEW` (plus optional VIP extra delay).
 * Same window logic applies to review reminder and repeat-promo sends.
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
  let sentFinalInvoice = 0;
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
      guest: { include: { segmentTags: { select: { tag: true } } } },
      property: { select: { checkInTime: true, checkOutTime: true } }
    };

    /** Post-stay journey applies to guests who were checked in on the PMS (`CHECKED_IN`) or never flipped from `CONFIRMED`. */
    const postStayBookingStatuses: BookingStatus[] = [BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN];

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
      include: { ...baseInclude, roomUnit: { select: { notes: true } } }
    });

    for (const b of forCheckinDay) {
      scanned++;
      if (isGuestEffectivelyCheckedIn(b)) {
        skipped++;
        continue;
      }
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
        arrivalSummary,
        hotelTimeZone: tz,
        now
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

    // --- AUTO_FINAL_INVOICE (runs BEFORE the post-checkout thank-you so the guest always
    // receives the operational document first, then any marketing/relationship follow-up later) ---
    //
    // Hospitality lifecycle rule:
    //   1) Stay ends (checkOut date has passed)
    //   2) Final invoice / folio summary is delivered immediately to the guest
    //   3) Only then does the post-stay thank-you / review request flow begin (with its own delays)
    //
    // The dedupe is the existing `BOOKING_INVOICE_PDF_SENT` audit row created by sendInvoicePdfForBooking.
    // If the front-desk button already sent the invoice, this pass is a no-op for that booking.
    const forFinalInvoice = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        status: { in: postStayBookingStatuses },
        paymentStatus: PaymentStatus.SUCCEEDED,
        checkOut: { lte: now }
      },
      select: { id: true }
    });
    for (const b of forFinalInvoice) {
      scanned++;
      const alreadySent = await hasFinalInvoiceBeenSent(b.id);
      if (alreadySent) {
        skipped++;
        continue;
      }
      const result = await sendInvoicePdfForBooking({
        hotelId: hotel.id,
        bookingId: b.id,
        trigger: "AUTO_FINAL_INVOICE_AFTER_STAY"
      }).catch((err) => {
        console.error(
          `[guest-journey] auto final invoice failed booking=${b.id}:`,
          err instanceof Error ? err.message : String(err)
        );
        return { sent: false, skipped: false, error: "exception" } as { sent: boolean; skipped: boolean; error?: string };
      });
      if (result.sent) sentFinalInvoice++;
      else skipped++;
    }

    // --- POST_CHECKOUT_THANK_YOU ---
    const forPostCheckout = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        status: { in: postStayBookingStatuses },
        paymentStatus: PaymentStatus.SUCCEEDED,
        guestJourneyPostCheckoutThankYouSentAt: null,
        checkOut: { lte: now }
      },
      include: baseInclude
    });

    for (const b of forPostCheckout) {
      scanned++;
      // GATE: never send the thank-you before the final invoice has been delivered.
      // This enforces the operational order Booking.com / Cloudbeds / Mews use: receipt first,
      // relationship messaging after. The auto-invoice pass above (or the front-desk button)
      // creates the audit row this check looks for.
      const invoiceSent = await hasFinalInvoiceBeenSent(b.id);
      if (!invoiceSent) {
        skipped++;
        logLifecycleScheduleDecision({
          event: "POST_CHECKOUT_THANK_YOU",
          bookingId: b.id,
          suppressed: true,
          suppressionReason: "final_invoice_not_yet_delivered"
        });
        continue;
      }
      const checkoutYmd = formatYmdInHotelZone(b.checkOut, tz);
      const hmOut = parseCheckOutHm(b.property.checkOutTime);
      const scheduledDeparture = wallClockLocalToUtc(checkoutYmd, hmOut, tz);
      if (Number.isNaN(scheduledDeparture.getTime())) {
        skipped++;
        continue;
      }

      const memThank = parseLightGuestMemory(b.guest.lightGuestMemoryJson ?? null);
      const thankYouEligibility = evaluateLifecycleMarketingEligibility("POST_CHECKOUT_THANK_YOU", {
        messagingDoNotDisturb: memThank.messagingDoNotDisturb,
        messagingMarketingOptOut: memThank.messagingMarketingOptOut
      });
      if (!thankYouEligibility.send) {
        skipped++;
        logLifecycleScheduleDecision({
          event: "POST_CHECKOUT_THANK_YOU",
          bookingId: b.id,
          suppressed: true,
          suppressionReason: thankYouEligibility.reason,
          segment: segmentForLifecycleBooking(b)
        });
        continue;
      }

      const thankYouBaseUtc = new Date(scheduledDeparture.getTime() + TWENTY_FOUR_HOURS_MS);
      const segmentThank = segmentForLifecycleBooking(b);
      const thankYouWindow = getLifecycleSendWindow(thankYouBaseUtc, tz, segmentThank);
      if (now.getTime() < thankYouWindow.adjustedUtc.getTime()) {
        skipped++;
        continue;
      }
      logLifecycleScheduleDecision({
        event: "POST_CHECKOUT_THANK_YOU",
        bookingId: b.id,
        originalPlannedSendTime: thankYouWindow.originalUtc.toISOString(),
        adjustedSendTime: thankYouWindow.adjustedUtc.toISOString(),
        timezoneUsed: tz,
        segment: segmentThank,
        windowReason: thankYouWindow.reason
      });

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
        status: { in: postStayBookingStatuses },
        paymentStatus: PaymentStatus.SUCCEEDED,
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
      const memRev = parseLightGuestMemory(b.guest.lightGuestMemoryJson ?? null);
      const reviewEligibility = evaluateLifecycleMarketingEligibility("REVIEW_REQUEST", {
        messagingDoNotDisturb: memRev.messagingDoNotDisturb,
        messagingMarketingOptOut: memRev.messagingMarketingOptOut
      });
      if (!reviewEligibility.send) {
        skipped++;
        logLifecycleScheduleDecision({
          event: "REVIEW_REQUEST",
          bookingId: b.id,
          suppressed: true,
          suppressionReason: reviewEligibility.reason,
          segment: segmentForLifecycleBooking(b)
        });
        continue;
      }

      const segmentRev = segmentForLifecycleBooking(b);
      const minAfterThankYouMs = envHoursToMs("GUEST_JOURNEY_MIN_HOURS_AFTER_THANK_YOU_BEFORE_REVIEW", 24);
      const vipExtraMs = segmentRev === "VIP" ? envHoursToMs("GUEST_JOURNEY_VIP_REVIEW_EXTRA_DELAY_HOURS", 12) : 0;
      const thankAt = b.guestJourneyPostCheckoutThankYouSentAt!;
      const reviewEarliestFromThankYou = new Date(thankAt.getTime() + minAfterThankYouMs + vipExtraMs);
      const reviewFromCheckout = new Date(scheduledDeparture.getTime() + reviewDelayMs);
      const reviewDesiredUtc = new Date(Math.max(reviewFromCheckout.getTime(), reviewEarliestFromThankYou.getTime()));
      const reviewWindow = getLifecycleSendWindow(reviewDesiredUtc, tz, segmentRev);
      if (now.getTime() < reviewWindow.adjustedUtc.getTime()) {
        skipped++;
        continue;
      }
      logLifecycleScheduleDecision({
        event: "REVIEW_REQUEST",
        bookingId: b.id,
        originalPlannedSendTime: reviewWindow.originalUtc.toISOString(),
        adjustedSendTime: reviewWindow.adjustedUtc.toISOString(),
        timezoneUsed: tz,
        segment: segmentRev,
        windowReason: reviewWindow.reason
      });

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
        feedbackRatingList: FEEDBACK_RATING_LIST
      });
      if (ok) sentReviewRequest++;
      else skipped++;
    }

    // --- REVIEW_REQUEST_REMINDER (once, 24h after review request, only when no feedback yet) ---
    const forReviewReminder = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        status: { in: postStayBookingStatuses },
        paymentStatus: PaymentStatus.SUCCEEDED,
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
      const memRem = parseLightGuestMemory(b.guest.lightGuestMemoryJson ?? null);
      const reminderEligibility = evaluateLifecycleMarketingEligibility("REVIEW_REMINDER", {
        messagingDoNotDisturb: memRem.messagingDoNotDisturb,
        messagingMarketingOptOut: memRem.messagingMarketingOptOut
      });
      if (!reminderEligibility.send) {
        skipped++;
        logLifecycleScheduleDecision({
          event: "REVIEW_REMINDER",
          bookingId: b.id,
          suppressed: true,
          suppressionReason: reminderEligibility.reason,
          segment: segmentForLifecycleBooking(b)
        });
        continue;
      }

      const reminderDelayMs = envHoursToMs("GUEST_JOURNEY_REVIEW_REMINDER_DELAY_HOURS", 24);
      const reminderDesiredUtc = new Date(reviewSentAt.getTime() + reminderDelayMs);
      const segmentRem = segmentForLifecycleBooking(b);
      const reminderWindow = getLifecycleSendWindow(reminderDesiredUtc, tz, segmentRem);
      if (now.getTime() < reminderWindow.adjustedUtc.getTime()) {
        skipped++;
        continue;
      }
      logLifecycleScheduleDecision({
        event: "REVIEW_REMINDER",
        bookingId: b.id,
        originalPlannedSendTime: reminderWindow.originalUtc.toISOString(),
        adjustedSendTime: reminderWindow.adjustedUtc.toISOString(),
        timezoneUsed: tz,
        segment: segmentRem,
        windowReason: reminderWindow.reason
      });
      const body = `${buildReviewRequestBody({
        guestFirstName: firstName(b.guest.fullName),
        hotelName: hotel.displayName
      })}\n\nA gentle nudge — your view still matters to us.`;
      const ok = await sendJourneyMessage({
        hotelId: hotel.id,
        phoneNumberId,
        booking: b,
        body,
        aiIntent: "REVIEW_REQUEST",
        markSent: { guestJourneyReviewReminderSentAt: new Date() },
        auditAction: "GUEST_JOURNEY_REVIEW_REQUEST_REMINDER_SENT",
        feedbackRatingList: FEEDBACK_RATING_LIST
      });
      if (ok) sentReviewReminder++;
      else skipped++;
    }

    // --- REPEAT_GUEST_PROMO (2+ completed stays at hotel, cooldown, once per booking + one per sweep per guest) ---
    const repeatPromoGuestDone = new Set<string>();
    const forRepeatPromo = await prisma.booking.findMany({
      where: {
        hotelId: hotel.id,
        status: { in: postStayBookingStatuses },
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
      const memPromo = parseLightGuestMemory(b.guest.lightGuestMemoryJson ?? null);
      const promoEligibility = evaluateLifecycleMarketingEligibility("REPEAT_GUEST_PROMO", {
        messagingDoNotDisturb: memPromo.messagingDoNotDisturb,
        messagingMarketingOptOut: memPromo.messagingMarketingOptOut
      });
      if (!promoEligibility.send) {
        skipped++;
        logLifecycleScheduleDecision({
          event: "REPEAT_GUEST_PROMO",
          bookingId: b.id,
          suppressed: true,
          suppressionReason: promoEligibility.reason,
          segment: segmentForLifecycleBooking(b)
        });
        continue;
      }

      const recentReviewAsk = await hasRecentOutboundJourneyIntents({
        hotelId: hotel.id,
        guestId: b.guestId,
        intents: ["REVIEW_REQUEST"],
        sinceMs: envHoursToMs("GUEST_JOURNEY_PROMO_MIN_GAP_AFTER_REVIEW_HOURS", 18)
      });
      if (recentReviewAsk) {
        skipped++;
        logLifecycleScheduleDecision({
          event: "REPEAT_GUEST_PROMO",
          bookingId: b.id,
          suppressed: true,
          suppressionReason: "recent_review_request_outbound"
        });
        continue;
      }

      const promoDesiredUtc = new Date(scheduledDeparture.getTime() + repeatPromoDelayMs);
      const segmentPromo = segmentForLifecycleBooking(b);
      const promoWindow = getLifecycleSendWindow(promoDesiredUtc, tz, segmentPromo);
      if (now.getTime() < promoWindow.adjustedUtc.getTime()) {
        skipped++;
        continue;
      }
      logLifecycleScheduleDecision({
        event: "REPEAT_GUEST_PROMO",
        bookingId: b.id,
        originalPlannedSendTime: promoWindow.originalUtc.toISOString(),
        adjustedSendTime: promoWindow.adjustedUtc.toISOString(),
        timezoneUsed: tz,
        segment: segmentPromo,
        windowReason: promoWindow.reason
      });

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
    sentFinalInvoice,
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
      r.sentRepeatGuestPromo +
      r.sentFinalInvoice,
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
