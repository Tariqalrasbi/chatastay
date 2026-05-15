/**
 * Human-readable labels for AuditLog rows.
 *
 * Goal: every staff/system action recorded in `AuditLog` should display as a
 * plain-English sentence in the admin UI, not a raw code like
 * `MANUAL_FRONT_DESK_CHECK_IN` or a JSON metadata blob. Used by:
 *  - the staff-activity timeline (`/admin/audit-trail`)
 *  - the smart handover sheet (`/admin/handover-sheet`)
 *  - any future "what did this person do today?" surface.
 *
 * Pure module — no Prisma imports, no DB calls.
 */

export type AuditCategory =
  | "Reservations"
  | "Front Desk"
  | "Payments"
  | "Housekeeping"
  | "Restaurant"
  | "Messaging"
  | "Settings"
  | "Reports"
  | "Security"
  | "System";

export interface FriendlyAuditLine {
  /** Single emoji icon for the timeline node. */
  icon: string;
  /** Short headline ("Checked in guest"). */
  headline: string;
  /** Optional context detail ("Room 102 · Booking ABC123"). */
  detail: string;
  /** Operational area, used to colour-code the timeline. */
  category: AuditCategory;
  /** Tailwind-ish hue token for the timeline dot. */
  accent: "green" | "blue" | "amber" | "purple" | "rose" | "slate" | "teal" | "sky";
}

const ACCENT_BY_CATEGORY: Record<AuditCategory, FriendlyAuditLine["accent"]> = {
  Reservations: "green",
  "Front Desk": "teal",
  Payments: "amber",
  Housekeeping: "sky",
  Restaurant: "purple",
  Messaging: "blue",
  Settings: "slate",
  Reports: "slate",
  Security: "rose",
  System: "slate"
};

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function pickName(metadata: Record<string, unknown>): string {
  return (
    str(metadata.guestName) ||
    str(metadata.fullName) ||
    str(metadata.recipientName) ||
    str(metadata.name) ||
    ""
  );
}

function pickRoom(metadata: Record<string, unknown>): string {
  return (
    str(metadata.unitName) ||
    str(metadata.roomUnitName) ||
    str(metadata.roomName) ||
    str(metadata.unit) ||
    ""
  );
}

function pickAmount(metadata: Record<string, unknown>): string {
  const raw = metadata.amount ?? metadata.grossAmount ?? metadata.totalAmount ?? metadata.value;
  const currency = str(metadata.currency);
  if (raw === undefined || raw === null) return "";
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) return "";
  const formatted = num.toFixed(2).replace(/\.00$/, "");
  return currency ? `${currency} ${formatted}` : formatted;
}

function joinDetail(...parts: Array<string | undefined | null | false>): string {
  return parts.filter((p): p is string => Boolean(p && String(p).trim().length)).join(" · ");
}

/**
 * Map a raw `AuditLog.action` (plus its parsed JSON metadata) to a human
 * sentence. Falls back to a generic line for unknown actions so legacy data
 * always renders something readable.
 */
export function describeAuditAction(
  action: string,
  metadata: Record<string, unknown> = {},
  entityType?: string
): FriendlyAuditLine {
  const guest = pickName(metadata);
  const room = pickRoom(metadata);
  const amount = pickAmount(metadata);
  const newStatus = str(metadata.newStatus) || str(metadata.status);
  const previousStatus = str(metadata.previousStatus) || str(metadata.fromStatus);
  const channel = str(metadata.channel);
  const reason = str(metadata.reason);

  switch (action) {
    // ----- Front desk core -----
    case "MANUAL_FRONT_DESK_CHECK_IN":
      return {
        icon: "🛎️",
        headline: guest ? `Checked in ${guest}` : "Checked in a guest",
        detail: joinDetail(room && `Room ${room}`, "Manual front desk"),
        category: "Front Desk",
        accent: "teal"
      };
    case "MANUAL_FRONT_DESK_CHECK_OUT":
      return {
        icon: "🚪",
        headline: guest ? `Checked out ${guest}` : "Checked out a guest",
        detail: joinDetail(room && `Room ${room}`, "Manual front desk"),
        category: "Front Desk",
        accent: "teal"
      };
    case "FRONT_DESK_CHECKOUT_PAYMENT_SETTLED":
      return {
        icon: "💳",
        headline: "Settled checkout payment",
        detail: joinDetail(guest, room && `Room ${room}`, amount),
        category: "Payments",
        accent: "amber"
      };
    case "FRONT_DESK_SHIFT_CLOSED":
      return {
        icon: "📒",
        headline: "Closed cashier shift",
        detail: joinDetail(str(metadata.shiftLabel), str(metadata.totalCash) ? `Cash ${metadata.totalCash}` : ""),
        category: "Front Desk",
        accent: "teal"
      };
    case "ROOM_BOARD_UNIT_STATUS":
      return {
        icon: "🛏️",
        headline: `Marked ${room ? `Room ${room}` : "a room"} as ${newStatus || "updated"}`,
        detail: joinDetail(previousStatus && `was ${previousStatus}`, reason),
        category: "Front Desk",
        accent: "teal"
      };
    case "ROOM_UNIT_GUEST_DETAILS":
      return {
        icon: "📝",
        headline: guest ? `Edited guest details for ${guest}` : "Edited guest details",
        detail: joinDetail(room && `Room ${room}`),
        category: "Front Desk",
        accent: "teal"
      };
    case "ROOM_UNIT_DETAILS_SENT_WHATSAPP":
      return {
        icon: "📲",
        headline: "Sent room details to guest on WhatsApp",
        detail: joinDetail(guest, room && `Room ${room}`),
        category: "Messaging",
        accent: "blue"
      };

    // ----- Reservations -----
    case "BOOKING_CREATED_FROM_CONVERSATION":
      return {
        icon: "📅",
        headline: guest ? `Booked ${guest} from a conversation` : "Booked a new reservation from a chat",
        detail: joinDetail(room && `Room ${room}`),
        category: "Reservations",
        accent: "green"
      };
    case "BOOKING_STATUS_UPDATED":
      return {
        icon: "🔁",
        headline: `Updated booking status to ${newStatus || "—"}`,
        detail: joinDetail(guest, previousStatus && `was ${previousStatus}`),
        category: "Reservations",
        accent: "green"
      };
    case "BOOKING_CONFIRMED_WITH_UNIT":
      return {
        icon: "✅",
        headline: guest ? `Confirmed booking for ${guest}` : "Confirmed booking",
        detail: joinDetail(room && `Room ${room}`),
        category: "Reservations",
        accent: "green"
      };
    case "BOOKING_ROOM_REASSIGNED":
      return {
        icon: "🔀",
        headline: guest ? `Moved ${guest} to a different room` : "Re-assigned booking to another room",
        detail: joinDetail(room && `New room ${room}`, str(metadata.previousUnitName) && `was ${str(metadata.previousUnitName)}`),
        category: "Reservations",
        accent: "green"
      };
    case "BOOKING_GROUP_ROOM_ADDED":
      return {
        icon: "➕",
        headline: "Added an extra room to a group booking",
        detail: joinDetail(guest, room && `Room ${room}`),
        category: "Reservations",
        accent: "green"
      };
    case "BOOKING_UNIT_SELECTED":
    case "BOOKING_UNIT_AUTO_ASSIGNED":
    case "BOOKING_UNIT_AUTO_ASSIGNED_BACKFILL":
      return {
        icon: "🛌",
        headline: guest ? `Assigned ${guest} to a room` : "Assigned booking to a room",
        detail: joinDetail(room && `Room ${room}`, action === "BOOKING_UNIT_SELECTED" ? "Manual" : "Automatic"),
        category: "Reservations",
        accent: "green"
      };
    case "BOOKING_PAYMENT_LINK_SENT":
      return {
        icon: "🔗",
        headline: guest ? `Sent a payment link to ${guest}` : "Sent a payment link",
        detail: joinDetail(amount, channel),
        category: "Payments",
        accent: "amber"
      };
    case "BOOKING_PAYMENT_UPDATED":
      return {
        icon: "💰",
        headline: `Updated payment status to ${newStatus || "—"}`,
        detail: joinDetail(guest, amount),
        category: "Payments",
        accent: "amber"
      };
    case "BOOKING_INVOICE_PDF_SENT":
      return {
        icon: "🧾",
        headline: "Sent invoice PDF to guest",
        detail: joinDetail(guest, room && `Room ${room}`),
        category: "Payments",
        accent: "amber"
      };

    // ----- Folio money lines -----
    case "FOLIO_CHARGE_POSTED":
      return {
        icon: "🧮",
        headline: "Posted a charge to a folio",
        detail: joinDetail(str(metadata.itemName), guest, room && `Room ${room}`, amount),
        category: "Payments",
        accent: "amber"
      };
    case "FOLIO_PAYMENT_POSTED":
      return {
        icon: "💵",
        headline: "Posted a payment on a folio",
        detail: joinDetail(guest, room && `Room ${room}`, amount, str(metadata.method) && `via ${metadata.method}`),
        category: "Payments",
        accent: "amber"
      };
    case "FOLIO_REFUND_POSTED":
      return {
        icon: "↩️",
        headline: "Refunded a folio line",
        detail: joinDetail(guest, amount),
        category: "Payments",
        accent: "amber"
      };
    case "FOLIO_TXN_VOIDED":
      return {
        icon: "🗑️",
        headline: "Voided a folio line",
        detail: joinDetail(str(metadata.itemName), reason),
        category: "Payments",
        accent: "amber"
      };

    // ----- Housekeeping -----
    case "HOUSEKEEPING_TASK_ASSIGNED":
      return {
        icon: "🧹",
        headline: `Assigned cleaning to ${str(metadata.assignedToName) || "a cleaner"}`,
        detail: joinDetail(room && `Room ${room}`),
        category: "Housekeeping",
        accent: "sky"
      };
    case "HOUSEKEEPING_TASK_REASSIGNED":
      return {
        icon: "🔁",
        headline: `Re-assigned cleaning to ${str(metadata.assignedToName) || "a cleaner"}`,
        detail: joinDetail(room && `Room ${room}`),
        category: "Housekeeping",
        accent: "sky"
      };
    case "HOUSEKEEPING_TASK_CLAIMED":
      return {
        icon: "🙋",
        headline: "Claimed a cleaning task",
        detail: joinDetail(room && `Room ${room}`),
        category: "Housekeeping",
        accent: "sky"
      };
    case "HOUSEKEEPING_TASK_STARTED":
      return {
        icon: "▶️",
        headline: "Started cleaning",
        detail: joinDetail(room && `Room ${room}`),
        category: "Housekeeping",
        accent: "sky"
      };
    case "HOUSEKEEPING_TASK_COMPLETED":
      return {
        icon: "✨",
        headline: "Finished cleaning a room",
        detail: joinDetail(room && `Room ${room}`),
        category: "Housekeeping",
        accent: "sky"
      };
    case "HOUSEKEEPING_TASK_ASSIGN_BLOCKED":
    case "HOUSEKEEPING_TASK_CLAIM_BLOCKED":
      return {
        icon: "🚫",
        headline: "Cleaning assignment blocked",
        detail: joinDetail(room && `Room ${room}`, reason),
        category: "Housekeeping",
        accent: "rose"
      };

    // ----- Restaurant / outlets -----
    case "OUTLET_ORDER_TICKET_STATUS":
      return {
        icon: "🍽️",
        headline: `Restaurant ticket → ${newStatus || "updated"}`,
        detail: joinDetail(str(metadata.outletKey), str(metadata.itemSummary), guest),
        category: "Restaurant",
        accent: "purple"
      };
    case "FB_ORDER_POSTED_TO_FOLIO":
      return {
        icon: "🍷",
        headline: "Sent a restaurant order to the room folio",
        detail: joinDetail(guest, room && `Room ${room}`, amount),
        category: "Restaurant",
        accent: "purple"
      };
    case "FB_WALK_IN_DIRECT_SALE":
      return {
        icon: "💳",
        headline: "Recorded a walk-in restaurant sale",
        detail: joinDetail(amount, str(metadata.outletKey)),
        category: "Restaurant",
        accent: "purple"
      };
    case "FB_WALK_IN_RECEIPT_SENT":
      return {
        icon: "🧾",
        headline: "Sent a walk-in restaurant receipt",
        detail: joinDetail(amount, channel),
        category: "Restaurant",
        accent: "purple"
      };
    case "FB_MENU_ITEM_ADDED":
      return {
        icon: "🍴",
        headline: `Added "${str(metadata.itemName) || "a menu item"}" to the menu`,
        detail: joinDetail(str(metadata.outletKey), amount),
        category: "Restaurant",
        accent: "purple"
      };
    case "FB_MENU_APPEND_PACK":
      return {
        icon: "📦",
        headline: "Imported a menu pack",
        detail: joinDetail(str(metadata.packName), str(metadata.added) && `${metadata.added} items`),
        category: "Restaurant",
        accent: "purple"
      };
    case "FB_OPERATIONAL_EXPENSE":
      return {
        icon: "🧾",
        headline: "Logged an F&B operating expense",
        detail: joinDetail(amount, str(metadata.note)),
        category: "Restaurant",
        accent: "purple"
      };

    // ----- Messaging / communications -----
    case "CONVERSATION_REPLY_SENT":
      return {
        icon: "💬",
        headline: guest ? `Replied to ${guest}` : "Replied to a conversation",
        detail: joinDetail(channel || "WhatsApp"),
        category: "Messaging",
        accent: "blue"
      };
    case "CONVERSATION_STATE_UPDATED":
      return {
        icon: "🔄",
        headline: `Conversation state → ${newStatus || "updated"}`,
        detail: joinDetail(guest, previousStatus && `was ${previousStatus}`),
        category: "Messaging",
        accent: "blue"
      };
    case "CONVERSATION_SWITCHED_TO_RECEPTIONIST":
      return {
        icon: "🤝",
        headline: "Handed a chat off to a receptionist",
        detail: joinDetail(guest),
        category: "Messaging",
        accent: "blue"
      };
    case "MARKETING_CAMPAIGN_SENT":
      return {
        icon: "📣",
        headline: `Sent a guest campaign${str(metadata.campaignName) ? `: ${metadata.campaignName}` : ""}`,
        detail: joinDetail(str(metadata.recipientCount) && `${metadata.recipientCount} recipients`),
        category: "Messaging",
        accent: "blue"
      };
    case "REPORTS_GUEST_BROADCAST_SENT":
      return {
        icon: "📢",
        headline: "Broadcast a guest message",
        detail: joinDetail(str(metadata.recipientCount) && `${metadata.recipientCount} recipients`),
        category: "Messaging",
        accent: "blue"
      };
    case "AUTO_FOLLOWUP_SENT":
      return {
        icon: "⏰",
        headline: "Sent an automatic follow-up",
        detail: joinDetail(guest, str(metadata.template)),
        category: "Messaging",
        accent: "blue"
      };

    // ----- Guest experience / segmentation -----
    case "GUEST_FEEDBACK_RATING_RECEIVED":
      return {
        icon: "⭐",
        headline: `Guest left a ${str(metadata.rating) || "feedback"} rating`,
        detail: joinDetail(guest, str(metadata.category)),
        category: "Reports",
        accent: "amber"
      };
    case "GUEST_INTENT_ACTION_TASK":
      return {
        icon: "🎯",
        headline: `Guest request → ${str(metadata.intent) || "task created"}`,
        detail: joinDetail(guest, room && `Room ${room}`),
        category: "Front Desk",
        accent: "teal"
      };
    case "GUEST_PHONE_UPDATED":
      return {
        icon: "📱",
        label: "Guest phone updated",
        tone: "neutral" as const
      };
    case "GUEST_SEGMENTATION_UPDATED":
      return {
        icon: "🏷️",
        headline: "Updated a guest's tags / segment",
        detail: joinDetail(guest, str(metadata.tags)),
        category: "Reports",
        accent: "slate"
      };
    case "GUEST_FOLLOWUP_CANCELLED":
      return {
        icon: "✉️",
        headline: "Cancelled a queued guest follow-up",
        detail: joinDetail(guest, str(metadata.guestId) && `Guest ${metadata.guestId}`),
        category: "Front Desk",
        accent: "slate"
      };
    case "GUEST_FOLLOWUP_SCHEDULED":
      return {
        icon: "📅",
        headline: "Scheduled a staff WhatsApp follow-up",
        detail: joinDetail(
          guest,
          str(metadata.scheduledFor) && `Due ${metadata.scheduledFor}`,
          str(metadata.messagePreview)
        ),
        category: "Front Desk",
        accent: "teal"
      };

    // ----- Inventory / settings / users -----
    case "ROOM_TYPE_UPDATED":
      return {
        icon: "🏨",
        headline: `Updated room type "${str(metadata.roomTypeName) || "—"}"`,
        detail: joinDetail(str(metadata.field) && `Changed ${metadata.field}`),
        category: "Settings",
        accent: "slate"
      };
    case "ROOM_OFFER_APPLIED":
    case "SEASONAL_RATE_APPLIED":
      return {
        icon: "💸",
        headline: action === "SEASONAL_RATE_APPLIED" ? "Applied a seasonal rate" : "Applied a room offer",
        detail: joinDetail(str(metadata.offerName), str(metadata.percentOff) && `${metadata.percentOff}% off`),
        category: "Settings",
        accent: "slate"
      };
    case "INVENTORY_UPDATED":
      return {
        icon: "📊",
        headline: "Adjusted availability / pricing",
        detail: joinDetail(str(metadata.roomTypeName), str(metadata.dateRange)),
        category: "Settings",
        accent: "slate"
      };
    case "AUTO_OPTIMIZATION_ADJUSTED":
      return {
        icon: "🤖",
        headline: "Auto-optimization adjusted prices",
        detail: joinDetail(str(metadata.summary)),
        category: "Settings",
        accent: "slate"
      };
    case "HOTEL_PARTNER_SETUP_UPDATED":
      return {
        icon: "⚙️",
        headline: "Updated property setup",
        detail: joinDetail(str(metadata.section)),
        category: "Settings",
        accent: "slate"
      };
    case "PARTNER_ONBOARDING_COMPLETED":
      return {
        icon: "🎉",
        headline: "Completed partner onboarding",
        detail: "",
        category: "Settings",
        accent: "slate"
      };
    case "HOTEL_USER_UPDATED":
      return {
        icon: "👤",
        headline: `Updated staff account ${str(metadata.targetEmail) || ""}`.trim(),
        detail: joinDetail(str(metadata.role) && `Role: ${metadata.role}`),
        category: "Settings",
        accent: "slate"
      };
    case "HOTEL_USER_DELETED":
    case "HOTEL_USER_DEACTIVATED_INSTEAD_OF_DELETE":
      return {
        icon: "🚷",
        headline:
          action === "HOTEL_USER_DELETED"
            ? `Deleted staff account ${str(metadata.targetEmail) || ""}`.trim()
            : `Deactivated staff account ${str(metadata.targetEmail) || ""}`.trim(),
        detail: "",
        category: "Settings",
        accent: "rose"
      };
    case "HOTEL_USER_PASSWORD_RESET_SENT_BY_MANAGER":
      return {
        icon: "🔐",
        headline: `Sent a password reset to ${str(metadata.targetEmail) || "a staff member"}`,
        detail: "",
        category: "Settings",
        accent: "slate"
      };

    // ----- Security -----
    case "STAFF_LOGIN_SUCCESS":
      return {
        icon: "🔓",
        headline: "Signed in",
        detail: joinDetail(str(metadata.role)),
        category: "Security",
        accent: "green"
      };
    case "STAFF_LOGIN_FAILED":
      return {
        icon: "🚫",
        headline: "Failed sign-in attempt",
        detail: joinDetail(str(metadata.attemptedEmail) || str(metadata.attemptedUsername), reason),
        category: "Security",
        accent: "rose"
      };
    case "PASSWORD_RESET_REQUESTED":
      return {
        icon: "✉️",
        headline: "Requested a password reset",
        detail: joinDetail(str(metadata.email)),
        category: "Security",
        accent: "rose"
      };
    case "PASSWORD_RESET_COMPLETED":
      return {
        icon: "🔒",
        headline: "Completed a password reset",
        detail: joinDetail(str(metadata.email)),
        category: "Security",
        accent: "rose"
      };
    case "PASSWORD_RESET_INVALID_TOKEN":
    case "PASSWORD_RESET_EXPIRED":
      return {
        icon: "⌛",
        headline: action === "PASSWORD_RESET_EXPIRED" ? "Password reset link expired" : "Invalid password reset attempt",
        detail: "",
        category: "Security",
        accent: "rose"
      };

    // ----- Setup / templates -----
    case "SETUP_TEST_TEMPLATE_SENT":
      return {
        icon: "📨",
        headline: "Sent a test WhatsApp template",
        detail: joinDetail(str(metadata.templateName)),
        category: "Settings",
        accent: "slate"
      };

    // ----- Owner / hotel lifecycle -----
    case "HOTEL_CREATED_BY_OWNER":
      return {
        icon: "🏢",
        headline: `Created hotel ${str(metadata.hotelName) || ""}`.trim(),
        detail: "",
        category: "Settings",
        accent: "slate"
      };
    case "HOTEL_ACTIVATED_VIA_SCRIPT":
    case "HOTEL_SUSPENDED_VIA_SCRIPT":
    case "HOTEL_HARD_DELETED":
      return {
        icon: "🛠️",
        headline:
          action === "HOTEL_ACTIVATED_VIA_SCRIPT"
            ? "Reactivated a hotel"
            : action === "HOTEL_SUSPENDED_VIA_SCRIPT"
              ? "Suspended a hotel"
              : "Permanently deleted a hotel",
        detail: joinDetail(str(metadata.hotelSlug)),
        category: "System",
        accent: "rose"
      };

    case "DECISION_EVENT":
      return {
        icon: "🧠",
        headline: `Decision event${str(metadata.decision) ? `: ${metadata.decision}` : ""}`,
        detail: joinDetail(str(metadata.summary)),
        category: "Reports",
        accent: "slate"
      };

    default:
      return genericLine(action, metadata, entityType, guest, room);
  }
}

function genericLine(
  action: string,
  metadata: Record<string, unknown>,
  entityType: string | undefined,
  guest: string,
  room: string
): FriendlyAuditLine {
  const niceAction = action.replace(/_/g, " ").toLowerCase();
  const headline = entityType
    ? `${niceAction.charAt(0).toUpperCase()}${niceAction.slice(1)} (${entityType})`
    : `${niceAction.charAt(0).toUpperCase()}${niceAction.slice(1)}`;
  return {
    icon: "📝",
    headline,
    detail: joinDetail(guest, room && `Room ${room}`, str(metadata.note) || str(metadata.summary)),
    category: "System",
    accent: "slate"
  };
}

/** Stable list of categories for filter dropdowns. */
export const AUDIT_CATEGORY_LIST: AuditCategory[] = [
  "Reservations",
  "Front Desk",
  "Payments",
  "Housekeeping",
  "Restaurant",
  "Messaging",
  "Settings",
  "Reports",
  "Security",
  "System"
];

/** Convenience accessor (kept exported for use in tests / pickers). */
export function accentFor(category: AuditCategory): FriendlyAuditLine["accent"] {
  return ACCENT_BY_CATEGORY[category];
}
