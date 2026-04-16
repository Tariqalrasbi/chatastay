import { BookingStatus, UserRole } from "@prisma/client";
import { prisma } from "../db";
import {
  mergePreferredActivitiesFromText,
  mergeSpecialRequestSnippet,
  noteGuestComplaintInMemory
} from "../core/lightGuestMemory";
import { trackDecisionEventSafe } from "../core/decisionAnalytics";
import { deriveCommerceTone, mapOperationalIntentToRole, rolePriority } from "./guestMessageOrchestration";

const NOTIFY_TYPE = "GUEST_JOURNEY_REPLY";
type GuestOperationalIntentCategory =
  | "arrival_time_update"
  | "late_arrival"
  | "arrival_support_request"
  | "on_the_way"
  | "early_checkin_request"
  | "late_checkout_request"
  | "special_request"
  | "payment_issue"
  | "booking_modification"
  | "cancellation_request"
  | "refund_request"
  | "complaint"
  | "dissatisfaction"
  | "escalation";
type UpsellResponse = "accepted" | "ignored";

export type GuestJourneyOperationalReply = {
  matched: boolean;
  bookingId?: string;
  referenceCode?: string | null;
  category?: GuestOperationalIntentCategory;
  rawMessage: string;
  parsedEta?: string | null;
  requiresStaffFollowUp?: boolean;
  /** When set, used by conversationController for createRoleRoutedNotification */
  staffFollowUpRoles?: UserRole[];
  upsellType?: "early_checkin_paid" | "late_checkout_paid" | "upgrade_interest" | "add_on_interest" | "activities_interest";
  guestResponse?: UpsellResponse;
  upsellTriggerReason?: string;
  upsellShownAt?: string;
};

function staffFollowUpRolesForCategory(category: GuestOperationalIntentCategory): UserRole[] {
  switch (category) {
    case "payment_issue":
    case "refund_request":
      return [UserRole.FINANCE, UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF];
    case "booking_modification":
    case "cancellation_request":
      return [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF];
    case "complaint":
    case "dissatisfaction":
      return [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF];
    case "escalation":
      return [UserRole.MANAGER, UserRole.FRONTDESK, UserRole.STAFF];
    case "late_checkout_request":
      return [UserRole.FRONTDESK, UserRole.HOUSEKEEPING, UserRole.MANAGER, UserRole.STAFF];
    default:
      return [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.STAFF];
  }
}

function detectGuestOperationalIntentCategory(text: string): GuestOperationalIntentCategory | null {
  const t = text.toLowerCase();
  // Specific intents first (avoid broad "request" matching payment/refund paths).
  if (/\b(want (a |the )?manager|speak to (a |the )?manager|talk to (a |the )?manager|serious issue|urgent problem|escalate)\b/.test(t))
    return "escalation";
  if (
    /\b(room is dirty|dirty room|ac not working|a\/c not working|air conditioning|not working|broken|problem with (the )?room|issue with (the )?room|complaint)\b/.test(t)
  )
    return "complaint";
  if (
    /\b(not satisfied|not happy|disappointed|this is not good|unhappy|very poor|terrible service|bad service)\b/.test(t)
  )
    return "dissatisfaction";
  if (
    /\b(payment failed|payment error|card not working|card declined|declined|transaction failed|charged but not confirmed|payment did not go through|could not pay)\b/.test(
      t
    )
  )
    return "payment_issue";
  if (/\b(refund|money back|when will i get (my )?refund|when will we get (our )?refund|return my money)\b/.test(t))
    return "refund_request";
  if (
    /\b(cancel (my |the )?booking|cancel (my |the )?reservation|i want to cancel|we want to cancel|please cancel|cancellation)\b/.test(
      t
    )
  )
    return "cancellation_request";
  if (
    /\b(change dates|change (my |the )?dates|modify (my |the )?booking|change room|different room|update guests|change number of guests|reschedule|change my booking)\b/.test(
      t
    )
  )
    return "booking_modification";
  if (/\b(early check[- ]?in|check[- ]?in early|arriving early|arrive early)\b/.test(t)) return "early_checkin_request";
  if (/\b(late check[- ]?out|check[- ]?out late|extend check[- ]?out|leave at \d{1,2}(?::\d{2})?\s*(am|pm)?)\b/.test(t))
    return "late_checkout_request";
  if (
    /\b(extra bed|birthday|honeymoon|baby crib|crib|special request|anniversary|room decoration|decorations)\b/.test(t)
  )
    return "special_request";
  if (/\b(arrangement|arrange|can you arrange|please arrange)\b/.test(t)) return "special_request";
  if (/\b(on my way|on the way|coming now|leaving now|headed there|heading there)\b/.test(t)) return "on_the_way";
  if (
    /\b(late|late arrival|arrive late|after midnight|midnight|check[- ]?in will be late|delayed|delay)\b/.test(t)
  )
    return "late_arrival";
  if (
    /\b(parking|valet|luggage|bags|baggage|assist|assistance|help with bags|help with luggage|carry bags)\b/.test(t)
  )
    return "arrival_support_request";
  if (/\b(arrive|arrival|eta|coming around|around|at)\b/.test(t) && parseEtaText(text)) return "arrival_time_update";
  return null;
}

function parseEtaText(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bafter midnight\b/.test(t)) return "after midnight";
  const ampm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (ampm) {
    const hour = parseInt(ampm[1], 10);
    const minute = ampm[2] ? parseInt(ampm[2], 10) : 0;
    if (hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
      const hh = String(hour).padStart(2, "0");
      const mm = String(minute).padStart(2, "0");
      return `${hh}:${mm} ${ampm[3].toLowerCase()}`;
    }
  }
  const twentyFour = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFour) {
    const hh = String(parseInt(twentyFour[1], 10)).padStart(2, "0");
    return `${hh}:${twentyFour[2]}`;
  }
  const aroundHour = t.match(/\b(?:around|about|eta|at)\s*(\d{1,2})\b/);
  if (aroundHour) {
    const h = parseInt(aroundHour[1], 10);
    if (h >= 1 && h <= 12) return `${String(h).padStart(2, "0")}:00`;
  }
  return null;
}

function detectUpsellMetadata(params: {
  category: GuestOperationalIntentCategory | null;
  text: string;
  booking: { totalAmount: number; nights: number; checkIn: Date };
}): {
  upsellType?: GuestJourneyOperationalReply["upsellType"];
  guestResponse?: UpsellResponse;
  upsellTriggerReason?: string;
} {
  const { category, text, booking } = params;
  if (!category) return {};
  const t = text.toLowerCase();
  const ignored = /\b(no|no thanks|not now|maybe later|skip)\b/.test(t);
  /** Support / payment / policy paths must not attach sales upsell signals to the same inbound message. */
  if (
    category === "complaint" ||
    category === "dissatisfaction" ||
    category === "payment_issue" ||
    category === "cancellation_request" ||
    category === "refund_request" ||
    category === "escalation"
  ) {
    return {};
  }
  const highValueBooking = booking.totalAmount >= 220;
  const longStay = booking.nights >= 3;
  const daysBeforeCheckIn = Math.floor((booking.checkIn.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const preArrivalWindow = daysBeforeCheckIn >= -1 && daysBeforeCheckIn <= 4;

  if (category === "early_checkin_request")
    return { upsellType: "early_checkin_paid", guestResponse: ignored ? "ignored" : "accepted", upsellTriggerReason: "early_checkin_request" };
  if (category === "late_checkout_request")
    return {
      upsellType: "late_checkout_paid",
      guestResponse: ignored ? "ignored" : "accepted",
      upsellTriggerReason: "late_checkout_request"
    };
  if (/\b(upgrade|better room|bigger room|suite)\b/.test(t))
    return { upsellType: "upgrade_interest", guestResponse: ignored ? "ignored" : "accepted", upsellTriggerReason: "guest_upgrade_interest" };
  if (/\b(extra bed|decoration|decorations|meals|meal plan|transport|transfer)\b/.test(t))
    return { upsellType: "add_on_interest", guestResponse: ignored ? "ignored" : "accepted", upsellTriggerReason: "guest_add_on_interest" };
  if (/\b(sand bike|sand biking|dune buggy|bbq|tour|tours|experience|experiences|activity|activities)\b/.test(t))
    return { upsellType: "activities_interest", guestResponse: ignored ? "ignored" : "accepted", upsellTriggerReason: "guest_activity_interest" };
  // Smart timing layer: offer activities in pre-arrival and upgrades for high-value bookings.
  if (category === "on_the_way" && preArrivalWindow) {
    return { upsellType: "activities_interest", guestResponse: ignored ? "ignored" : "accepted", upsellTriggerReason: "pre_arrival_timing" };
  }
  if (category === "booking_modification" && highValueBooking) {
    return { upsellType: "upgrade_interest", guestResponse: ignored ? "ignored" : "accepted", upsellTriggerReason: "high_value_booking" };
  }
  if (category === "special_request" && longStay) {
    return { upsellType: "add_on_interest", guestResponse: ignored ? "ignored" : "accepted", upsellTriggerReason: "long_stay_add_on" };
  }
  return {};
}

function categoryToIntent(category: GuestOperationalIntentCategory): string {
  if (category === "arrival_time_update") return "GUEST_ARRIVAL_TIME_UPDATE";
  if (category === "late_arrival") return "GUEST_LATE_ARRIVAL";
  if (category === "arrival_support_request") return "GUEST_ARRIVAL_SUPPORT_REQUEST";
  if (category === "on_the_way") return "GUEST_ON_THE_WAY";
  if (category === "early_checkin_request") return "GUEST_EARLY_CHECKIN_REQUEST";
  if (category === "late_checkout_request") return "GUEST_LATE_CHECKOUT_REQUEST";
  if (category === "special_request") return "GUEST_SPECIAL_REQUEST";
  if (category === "payment_issue") return "GUEST_PAYMENT_ISSUE";
  if (category === "booking_modification") return "GUEST_BOOKING_MODIFICATION";
  if (category === "cancellation_request") return "GUEST_CANCELLATION_REQUEST";
  if (category === "refund_request") return "GUEST_REFUND_REQUEST";
  if (category === "complaint") return "GUEST_COMPLAINT";
  if (category === "dissatisfaction") return "GUEST_DISSATISFACTION";
  return "GUEST_ESCALATION";
}

function categoryToDecisionEvent(category: GuestOperationalIntentCategory): string | null {
  if (category === "early_checkin_request") return "early_checkin_requested";
  if (category === "late_checkout_request") return "late_checkout_requested";
  if (category === "special_request") return "special_request";
  if (category === "payment_issue") return "payment_issue";
  if (category === "complaint" || category === "dissatisfaction") return "complaint";
  if (category === "escalation") return "escalation";
  return null;
}

function isArrivalFamilyCategory(category: GuestOperationalIntentCategory): boolean {
  return (
    category === "arrival_time_update" ||
    category === "late_arrival" ||
    category === "arrival_support_request" ||
    category === "on_the_way" ||
    category === "early_checkin_request" ||
    category === "late_checkout_request" ||
    category === "special_request"
  );
}

/**
 * When a guest replies after any automated guest-journey WhatsApp (24h pre-arrival, check-in day, post-checkout thank-you,
 * review request, repeat-guest promo, or legacy pre-arrival reminder), tag the message and create an in-app notification for staff.
 */
export async function handleGuestJourneyInboundReply(params: {
  hotelId: string;
  guestId: string;
  conversationId: string;
  prismaMessageId: string;
  messageBody: string;
  providerMessageId?: string;
}): Promise<GuestJourneyOperationalReply> {
  const booking = await prisma.booking.findFirst({
    where: {
      hotelId: params.hotelId,
      guestId: params.guestId,
      status: BookingStatus.CONFIRMED,
      OR: [
        { guestJourneyPreArrival24hSentAt: { not: null } },
        { guestJourneyCheckinDaySentAt: { not: null } },
        { guestJourneyPostCheckoutThankYouSentAt: { not: null } },
        { guestJourneyReviewRequestSentAt: { not: null } },
        { guestJourneyRepeatPromoSentAt: { not: null } },
        { preArrivalReminderSentAt: { not: null } }
      ]
    },
    orderBy: { checkOut: "desc" },
    include: { guest: true }
  });

  if (!booking) {
    return { matched: false, rawMessage: params.messageBody };
  }

  const category = detectGuestOperationalIntentCategory(params.messageBody);
  const parsedEta = parseEtaText(params.messageBody);
  const upsellMeta = detectUpsellMetadata({
    category,
    text: params.messageBody,
    booking: { totalAmount: booking.totalAmount, nights: booking.nights, checkIn: booking.checkIn }
  });
  const aiIntent = category ? categoryToIntent(category) : "GUEST_JOURNEY_REPLY";
  const requiresStaffFollowUp =
    category != null &&
    category !== "arrival_time_update" &&
    category !== "on_the_way";
  const staffFollowUpRoles =
    category && requiresStaffFollowUp ? staffFollowUpRolesForCategory(category) : undefined;

  if (!booking.conversationId) {
    await prisma.booking.update({
      where: { id: booking.id },
      data: { conversationId: params.conversationId }
    });
  }

  const guestLabel = booking.guest.fullName?.trim() || booking.guest.phoneE164;
  const ref = booking.referenceCode?.trim() || booking.id.slice(0, 10);
  const preview = params.messageBody.trim().slice(0, 280);
  const title = category
    ? `Guest ${category.replaceAll("_", " ")} · ${guestLabel} · ${ref}`
    : `Guest journey reply · ${guestLabel} · ${ref}`;
  const body = category
    ? `${guestLabel} (${ref}) sent ${category.replaceAll("_", " ")} update: ${preview}`
    : `${guestLabel} (${ref}) replied after an automated stay message: ${preview}`;
  const orchRole = category ? mapOperationalIntentToRole(category) : null;
  const commerceTone = category ? deriveCommerceTone(upsellMeta.upsellType, category) : null;
  const metadata = {
    bookingId: booking.id,
    conversationId: params.conversationId,
    referenceCode: booking.referenceCode,
    providerMessageId: params.providerMessageId ?? null,
    prismaMessageId: params.prismaMessageId,
    category: category ?? "guest_journey_guest_message",
    parsedEta,
    rawMessage: params.messageBody,
    detectedAt: new Date().toISOString(),
    upsellType: upsellMeta.upsellType ?? null,
    guestResponse: upsellMeta.guestResponse ?? null,
    upsellTriggerReason: upsellMeta.upsellTriggerReason ?? null,
    upsellShown: Boolean(upsellMeta.upsellType),
    upsellShownAt: upsellMeta.upsellType ? new Date().toISOString() : null,
    orchestrationRole: orchRole,
    orchestrationPriority: orchRole ? rolePriority(orchRole) : null,
    orchestrationCommerceTone: commerceTone,
    invokedHandler: "guest_journey_operational"
  };

  await prisma.$transaction([
    prisma.message.update({
      where: { id: params.prismaMessageId },
      data: { aiIntent, aiConfidence: category ? 0.97 : 0.95 }
    }),
    prisma.notification.create({
      data: {
        hotelId: params.hotelId,
        guestId: params.guestId,
        channel: "IN_APP",
        type: NOTIFY_TYPE,
        title,
        body,
        status: "PENDING",
        payloadJson: JSON.stringify(metadata)
      }
    }),
    prisma.auditLog.create({
      data: {
        hotelId: params.hotelId,
        action:
          category && isArrivalFamilyCategory(category)
            ? "GUEST_ARRIVAL_OPERATIONAL_UPDATE"
            : "GUEST_SERVICE_OPERATIONAL_UPDATE",
        entityType: "BOOKING",
        entityId: booking.id,
        bookingId: booking.id,
        metadataJson: JSON.stringify(metadata)
      }
    })
  ]);

  const memHooks: Promise<unknown>[] = [];
  if (category === "complaint" || category === "dissatisfaction") {
    memHooks.push(noteGuestComplaintInMemory(params.guestId));
  }
  if (category === "special_request") {
    memHooks.push(mergeSpecialRequestSnippet(params.guestId, params.messageBody));
  }
  if (upsellMeta.upsellType === "activities_interest" || /\b(dune|buggy|bbq|sand bike|tour|activity)\b/i.test(params.messageBody)) {
    memHooks.push(mergePreferredActivitiesFromText(params.guestId, params.messageBody));
  }
  await Promise.all(memHooks).catch((err) =>
    console.error("[light-guest-memory] journey hook failed:", err instanceof Error ? err.message : String(err))
  );

  if (category) {
    const eventType = categoryToDecisionEvent(category);
    if (eventType) {
      await trackDecisionEventSafe({
        hotelId: params.hotelId,
        eventType: eventType as
          | "early_checkin_requested"
          | "late_checkout_requested"
          | "special_request"
          | "payment_issue"
          | "complaint"
          | "escalation",
        guestId: params.guestId,
        bookingId: booking.id,
        conversationId: params.conversationId,
        source: "journey_intent"
      });
    }
  }
  if (upsellMeta.upsellType) {
    await trackDecisionEventSafe({
      hotelId: params.hotelId,
      eventType: "upsell_shown",
      guestId: params.guestId,
      bookingId: booking.id,
      conversationId: params.conversationId,
      source: "journey_upsell",
      dedupeKey: `upsell_shown:${params.prismaMessageId}:${upsellMeta.upsellType}`,
      metadata: { upsellType: upsellMeta.upsellType }
    });
    if (upsellMeta.guestResponse === "accepted" || upsellMeta.guestResponse === "ignored") {
      await trackDecisionEventSafe({
        hotelId: params.hotelId,
        eventType: upsellMeta.guestResponse === "accepted" ? "upsell_accepted" : "upsell_ignored",
        guestId: params.guestId,
        bookingId: booking.id,
        conversationId: params.conversationId,
        source: "journey_upsell",
        dedupeKey: `upsell_${upsellMeta.guestResponse}:${params.prismaMessageId}:${upsellMeta.upsellType}`,
        metadata: { upsellType: upsellMeta.upsellType }
      });
    }
  }

  return {
    matched: Boolean(category),
    bookingId: booking.id,
    referenceCode: booking.referenceCode,
    category: category ?? undefined,
    rawMessage: params.messageBody,
    parsedEta,
    requiresStaffFollowUp,
    staffFollowUpRoles,
    upsellType: upsellMeta.upsellType,
    guestResponse: upsellMeta.guestResponse,
    upsellTriggerReason: upsellMeta.upsellTriggerReason,
    upsellShownAt: upsellMeta.upsellType ? new Date().toISOString() : undefined
  };
}

/** @deprecated Use handleGuestJourneyInboundReply */
export const handlePreArrivalInboundGuestReply = handleGuestJourneyInboundReply;
