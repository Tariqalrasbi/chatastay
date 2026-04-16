import type { GuestJourneyOperationalReply } from "./preArrivalGuestReplyNotify";

/**
 * Thin coordination layer (Prompt #9): maps journey intents → internal roles,
 * applies priority, and ensures one guest-facing outcome without duplicating
 * detection in `preArrivalGuestReplyNotify` (that module remains source of truth).
 */

export type GuestFacingRole = "support" | "receptionist" | "sales" | "concierge";

export type NormalizedOperationalIntent = NonNullable<GuestJourneyOperationalReply["category"]>;

const SUPPORT_INTENTS = new Set<NormalizedOperationalIntent>([
  "complaint",
  "dissatisfaction",
  "payment_issue",
  "cancellation_request",
  "refund_request",
  "escalation"
]);

/** Lower number = higher priority when combining signals (support wins). */
const ROLE_PRIORITY: Record<GuestFacingRole, number> = {
  support: 1,
  receptionist: 2,
  sales: 3,
  concierge: 4
};

export function mapOperationalIntentToRole(category: NormalizedOperationalIntent): GuestFacingRole {
  if (SUPPORT_INTENTS.has(category)) return "support";
  if (
    category === "arrival_time_update" ||
    category === "late_arrival" ||
    category === "on_the_way" ||
    category === "arrival_support_request" ||
    category === "early_checkin_request" ||
    category === "late_checkout_request" ||
    category === "special_request" ||
    category === "booking_modification"
  ) {
    return "receptionist";
  }
  return "receptionist";
}

export function rolePriority(role: GuestFacingRole): number {
  return ROLE_PRIORITY[role];
}

/** Support and payment flows must not attach commercial upsell metadata to the same message. */
export function shouldSuppressOperationalUpsell(category: NormalizedOperationalIntent): boolean {
  return SUPPORT_INTENTS.has(category);
}

/** Staff/analytics hint: which commercial tone the upsell copy aligns with (null when none or suppressed). */
export function deriveCommerceTone(
  upsell: GuestJourneyOperationalReply["upsellType"] | null | undefined,
  category: NormalizedOperationalIntent | null
): "sales" | "concierge" | null {
  if (!category || !upsell) return null;
  if (shouldSuppressOperationalUpsell(category)) return null;
  if (upsell === "activities_interest") return "concierge";
  if (
    upsell === "upgrade_interest" ||
    upsell === "add_on_interest" ||
    upsell === "early_checkin_paid" ||
    upsell === "late_checkout_paid"
  ) {
    return "sales";
  }
  return null;
}

export function effectiveOperationalUpsellType(
  category: NormalizedOperationalIntent,
  journeyUpsell: GuestJourneyOperationalReply["upsellType"],
  opts?: { guestHadComplaintFlag?: boolean }
): GuestJourneyOperationalReply["upsellType"] {
  if (shouldSuppressOperationalUpsell(category)) return undefined;
  if (!journeyUpsell) return undefined;
  if (opts?.guestHadComplaintFlag && (journeyUpsell === "upgrade_interest" || journeyUpsell === "add_on_interest")) {
    return undefined;
  }
  return journeyUpsell;
}

export type OrchestratedGuestJourneyOutbound = {
  replyBody: string;
  aiIntent: string;
  /** When false, staff notification must not mention upsell interest for this turn. */
  staffUpsellAppend: boolean;
  meta: {
    normalizedIntent: NormalizedOperationalIntent;
    /** Primary coordinator role (support wins over commercial tone). */
    role: GuestFacingRole;
    /** When set, guest-facing copy for this turn came from sales or concierge vocabulary. */
    commerceTone?: "sales" | "concierge";
    priority: number;
    upsellSuppressed: boolean;
    effectiveUpsellType?: GuestJourneyOperationalReply["upsellType"];
    invokedHandler: "guest_journey_operational";
  };
};

type MemorySlice = {
  hadComplaint?: boolean;
  preferredActivities?: string[];
};

/**
 * Single coordinated guest reply for journey/operational intents (Prompts 1–5, 7–8).
 * Personalization (memory) is applied here only after role/upsell gating.
 */
export function buildGuestJourneyOrchestratedReply(params: {
  journey: GuestJourneyOperationalReply;
  memory: MemorySlice;
  repeatGuestSoft: boolean;
  activitiesFromMemory: boolean;
}): OrchestratedGuestJourneyOutbound {
  const cat = params.journey.category!;
  const role = mapOperationalIntentToRole(cat);
  const priority = rolePriority(role);
  const upsellSuppressed = shouldSuppressOperationalUpsell(cat);
  const effectiveUpsell = effectiveOperationalUpsellType(cat, params.journey.upsellType, {
    guestHadComplaintFlag: Boolean(params.memory.hadComplaint)
  });

  let replyBody = "Thank you, we have noted your update and our team will coordinate with you if needed.";

  if (!upsellSuppressed && effectiveUpsell === "upgrade_interest") {
    if (params.memory.hadComplaint) {
      replyBody =
        "Thank you for your message. If you would like to explore a different room category, our team can share options with care.";
    } else if (params.repeatGuestSoft) {
      replyBody =
        "Whenever you are ready, we have premium room types that may suit you from previous stays. There is no pressure — reply if you would like options.";
    } else {
      replyBody =
        "We also have upgraded room options available for a more enhanced experience. Let us know if you would like to explore upgrade options.";
    }
  } else if (!upsellSuppressed && effectiveUpsell === "add_on_interest") {
    replyBody =
      "We can also arrange additional services such as extra beds, decorations, or meals. Let us know if you would like to add any.";
  } else if (!upsellSuppressed && effectiveUpsell === "activities_interest") {
    replyBody = params.activitiesFromMemory
      ? "We can arrange favourite experiences again — including dune buggy and BBQ options when it suits you. Reply if you would like more details."
      : "We offer activities such as sand biking, dune buggies, and BBQ experiences. Let us know if you would like more details.";
  } else if (cat === "arrival_time_update") {
    const etaPart = params.journey.parsedEta ? ` around ${params.journey.parsedEta}` : " with your expected arrival time";
    replyBody = `Thank you, we have noted your arrival${etaPart}. We look forward to welcoming you. If you need parking, luggage assistance, or anything else before arrival, just reply here.`;
  } else if (cat === "late_arrival") {
    replyBody =
      "Thank you for letting us know. We have noted your late arrival. If your arrival time changes further or you need any assistance before reaching the resort, please reply here and our team will assist.";
  } else if (cat === "on_the_way") {
    replyBody =
      "Thank you, we have noted that you are on the way. We look forward to welcoming you. If you need parking or luggage assistance on arrival, please reply here.";
  } else if (cat === "arrival_support_request") {
    replyBody =
      "Thank you. We have noted your request and our team will coordinate with you. If you would like, you can also share your expected arrival time here.";
  } else if (cat === "early_checkin_request") {
    replyBody =
      "We may be able to offer early check-in for an additional fee, subject to availability. Please let us know if you would like us to arrange this for you.";
  } else if (cat === "late_checkout_request") {
    replyBody =
      "We can offer a late check-out option for an additional charge, depending on availability. Let us know if you would like us to arrange it.";
  } else if (cat === "special_request") {
    replyBody = "Thank you for your request. We have noted it and our team will coordinate accordingly.";
  } else if (cat === "payment_issue") {
    replyBody =
      "Thank you for informing us. It seems there may have been an issue with the payment. Our team will review this and assist you shortly. If needed, we will guide you on the next step.";
  } else if (cat === "booking_modification") {
    replyBody =
      "Thank you for your request. We have noted your booking modification and our team will review availability and get back to you shortly.";
  } else if (cat === "cancellation_request") {
    replyBody =
      "Thank you for your request. We have received your cancellation request and will process it according to the booking policy. Our team will confirm shortly.";
  } else if (cat === "refund_request") {
    replyBody =
      "Thank you for your message. We have noted your refund request. Our team will review it based on the booking policy and update you shortly.";
  } else if (cat === "complaint") {
    replyBody =
      "We are very sorry to hear this. Thank you for bringing it to our attention. Our team will address this as soon as possible.";
  } else if (cat === "dissatisfaction") {
    replyBody =
      "We truly appreciate your feedback and are sorry your experience did not meet expectations. Our team will review this and assist you.";
  } else if (cat === "escalation") {
    replyBody =
      "We sincerely apologize for the inconvenience. Your concern is important to us and has been escalated to our team for immediate attention.";
  }

  const staffUpsellAppend =
    Boolean(effectiveUpsell) &&
    !upsellSuppressed &&
    params.journey.guestResponse === "accepted" &&
    role !== "support";

  const commerceTone: "sales" | "concierge" | undefined =
    !effectiveUpsell || upsellSuppressed
      ? undefined
      : effectiveUpsell === "activities_interest"
        ? "concierge"
        : effectiveUpsell === "upgrade_interest" || effectiveUpsell === "add_on_interest"
          ? "sales"
          : effectiveUpsell === "early_checkin_paid" || effectiveUpsell === "late_checkout_paid"
            ? "sales"
            : undefined;

  const aiIntent = [
    `GUEST_${cat.toUpperCase()}`,
    `orch_role=${role}`,
    commerceTone ? `orch_tone=${commerceTone}` : "orch_tone=receptionist",
    `orch_pri=${priority}`,
    effectiveUpsell ? `orch_upsell=${effectiveUpsell}` : "orch_upsell=none",
    upsellSuppressed ? "orch_upsell_suppressed=1" : "orch_upsell_suppressed=0"
  ].join("|");

  return {
    replyBody,
    aiIntent,
    staffUpsellAppend,
    meta: {
      normalizedIntent: cat,
      role,
      commerceTone,
      priority,
      upsellSuppressed,
      effectiveUpsellType: effectiveUpsell,
      invokedHandler: "guest_journey_operational"
    }
  };
}
