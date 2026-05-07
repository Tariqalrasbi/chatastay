/**
 * Hospitality-readable labels for internal codes.
 *
 * Internal codes (button payloads, AI intents, complaint slugs, extra-item slugs, etc.) must
 * never be the primary visible text shown to hotel staff in notifications, the conversation
 * page, or operational dashboards. This module is the single source of truth that converts
 * those codes into front-desk friendly English.
 *
 * Inspired by Booking.com Extranet, Cloudbeds, Opera, Mews, Guesty, Hotelogix wording.
 */

export type OperationalRequestKind =
  | "housekeeping"
  | "maintenance"
  | "restaurant"
  | "activities"
  | "front_desk"
  | "complaint"
  | "general";

const COMPLAINT_CATEGORY_LABEL: Record<string, string> = {
  noise: "noise",
  clean: "cleanliness",
  staff: "service / staff",
  fb: "food & drinks",
  bill: "billing / folio",
  other: "general"
};

const EXTRA_ITEM_LABEL: Record<string, string> = {
  mattress: "extra mattress",
  pillow: "extra pillow",
  sheet: "extra sheet",
  blanket: "extra blanket",
  towels: "extra towels",
  toiletries: "toiletries",
  water: "drinking water",
  trash: "trash pickup",
  maintenance: "maintenance issue"
};

const MAINTENANCE_KIND_LABEL: Record<string, string> = {
  ac: "AC issue",
  tv: "TV issue",
  bathroom: "bathroom issue",
  plumbing: "plumbing issue",
  electricity: "electricity issue",
  water: "water issue",
  internet: "Wi-Fi / internet issue",
  other: "maintenance issue"
};

const HOUSEKEEPING_KIND_LABEL: Record<string, string> = {
  refresh: "room refresh",
  cleaning: "room cleaning",
  trash: "trash pickup"
};

/** Map a complaint sub-category slug to a guest-friendly description. */
export function complaintCategoryLabel(slug: string | null | undefined): string {
  const s = String(slug ?? "").trim().toLowerCase();
  return COMPLAINT_CATEGORY_LABEL[s] ?? "general";
}

/** Map an in-stay extra-item slug (e.g. "pillow", "towels") to a readable label. */
export function extraItemLabel(slug: string | null | undefined): string {
  const s = String(slug ?? "").trim().toLowerCase();
  return EXTRA_ITEM_LABEL[s] ?? s.replace(/[_-]+/g, " ") ?? "item";
}

/** Map a maintenance sub-category slug (ac, tv, plumbing…) to a readable label. */
export function maintenanceKindLabel(slug: string | null | undefined): string {
  const s = String(slug ?? "").trim().toLowerCase();
  return MAINTENANCE_KIND_LABEL[s] ?? "maintenance issue";
}

/** Map a housekeeping sub-category slug (refresh, cleaning, trash) to a readable label. */
export function housekeepingKindLabel(slug: string | null | undefined): string {
  const s = String(slug ?? "").trim().toLowerCase();
  return HOUSEKEEPING_KIND_LABEL[s] ?? "housekeeping";
}

/**
 * Build a one-line operational summary like "Room 204 requested 2 extra pillows."
 * Falls back gracefully when room number is unknown.
 */
export function buildOperationalRequestSummary(params: {
  kind: OperationalRequestKind;
  itemLabel: string;
  quantity?: number | null;
  roomLabel?: string | null;
}): string {
  const where = params.roomLabel?.trim() ? `Room ${params.roomLabel.trim()}` : "Guest";
  const verb =
    params.kind === "complaint"
      ? "reported"
      : params.kind === "maintenance"
        ? "reported"
        : "requested";
  const qty = params.quantity && params.quantity > 1 ? ` ${params.quantity}` : "";
  const item = params.itemLabel.trim();
  return `${where} ${verb}${qty ? qty : ""} ${item}.`.replace(/\s+/g, " ").trim();
}

/**
 * Convert an `aiIntent` code stored on Message into a readable line for hotel staff.
 * Returns `null` when the intent is internal/flow plumbing that should not be surfaced.
 */
export function aiIntentDisplayLabel(aiIntent: string | null | undefined): string | null {
  const v = String(aiIntent ?? "").trim();
  if (!v) return null;

  // Internal flow steps that staff should NOT see as a user-facing intent badge.
  const HIDDEN = new Set<string>([
    "MANUAL_REPLY",
    "GUEST_JOURNEY_REPLY",
    "PRE_ARRIVAL_GUEST_REPLY",
    "BOOKING_CHANGE_MENU",
    "AGENT_HANDOFF",
    "IN_STAY_SERVICE_MENU",
    "IN_STAY_WELCOME_MENU",
    "IN_STAY_VIEW_STAY",
    "IN_STAY_EXTRA_REQUEST_LOGGED",
    "IN_STAY_COMPLAINT_RECEIVED",
    "CHECK_IN_BILL_SUMMARY"
  ]);
  if (HIDDEN.has(v)) return null;

  const FRIENDLY: Record<string, string> = {
    PRE_ARRIVAL_24H: "Pre-arrival reminder",
    CHECKIN_DAY: "Arrival day message",
    POST_CHECKOUT_THANK_YOU: "Post-stay thank-you",
    REVIEW_REQUEST: "Review request",
    REPEAT_GUEST_PROMO: "Repeat-guest offer",
    GUEST_COMPLAINT: "Complaint",
    GUEST_DISSATISFACTION: "Guest dissatisfaction",
    GUEST_ESCALATION: "Escalation",
    GUEST_PAYMENT_ISSUE: "Payment issue",
    GUEST_REFUND_REQUEST: "Refund request",
    GUEST_CANCELLATION_REQUEST: "Cancellation request",
    GUEST_BOOKING_MODIFICATION: "Booking modification",
    GUEST_SPECIAL_REQUEST: "Special request",
    GUEST_LATE_CHECKOUT_REQUEST: "Late check-out request",
    GUEST_EARLY_CHECKIN_REQUEST: "Early check-in request",
    GUEST_LATE_ARRIVAL: "Late arrival",
    GUEST_ARRIVAL_SUPPORT_REQUEST: "Arrival support",
    GUEST_ARRIVAL_TIME_UPDATE: "Arrival time update",
    GUEST_ON_THE_WAY: "On the way"
  };
  if (FRIENDLY[v]) return FRIENDLY[v];

  // Fallback: lowercase + remove prefix + spaces.
  return v
    .replace(/^(GUEST_|PRE_|POST_)/, "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}
