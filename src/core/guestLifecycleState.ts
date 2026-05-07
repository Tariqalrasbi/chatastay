/**
 * Phase F — guest relationship lifecycle helper.
 *
 * The master prompt requires twelve relationship-level states:
 *   UNKNOWN_GUEST → INQUIRY → SEARCHING_HOTELS → VIEWING_PROPERTY →
 *   BOOKING_IN_PROGRESS → CONFIRMED → PRE_ARRIVAL → CHECKED_IN → IN_HOUSE →
 *   CHECKED_OUT → POST_STAY → RETURNING_GUEST
 *
 * These describe a *guest-as-relationship* over time, not the operational
 * status of a single transaction (`Booking.status`) nor the live menu step
 * (`ConversationSession.stage`). Today the codebase has the transactional
 * + step states only, which is why several call-sites (in-stay welcome gate,
 * WhatsApp menu reset, PMS chat header) re-derive lifecycle inline with
 * subtly different rules. This helper consolidates that derivation.
 *
 * Phase F deliberately ships a derived computation only — no schema change,
 * no migration. Plumbed into:
 *   1. WhatsApp routing (conversationController) — surfaces the state on
 *      every inbound turn so future menu copy can branch off it.
 *   2. In-stay welcome gate (sendInStayWelcomeMenuIfEligible) — refuses to
 *      send the in-stay menu unless the booking is in `IN_HOUSE`.
 *   3. PMS conversation page (admin /conversations/:id) — renders a small
 *      badge so staff can see the relationship state at a glance.
 *
 * Returning the most-relevant booking alongside the state lets callers avoid
 * a second query for "the booking this state is anchored to".
 */

import { BookingStatus } from "@prisma/client";

export type GuestLifecycleState =
  | "UNKNOWN_GUEST"
  | "INQUIRY"
  | "SEARCHING_HOTELS"
  | "VIEWING_PROPERTY"
  | "BOOKING_IN_PROGRESS"
  | "CONFIRMED"
  | "PRE_ARRIVAL"
  | "CHECKED_IN"
  | "IN_HOUSE"
  | "CHECKED_OUT"
  | "POST_STAY"
  | "RETURNING_GUEST";

export type LifecycleBookingShape = {
  id: string;
  status: BookingStatus;
  checkIn: Date;
  checkOut: Date;
  createdAt: Date;
};

export type LifecycleGuestShape = {
  id: string;
  /// Optional — when the WhatsApp side hasn't captured a name yet.
  fullName?: string | null;
  /// Total prior confirmed/checked-in/checked-out bookings for this guest at
  /// THIS hotel. Used to decide RETURNING_GUEST.
  priorStaysCount?: number;
};

/// Conversation-side hint so we can distinguish UNKNOWN_GUEST vs INQUIRY without
/// querying messages directly. Optional; when absent we fall back to "no hint".
export type LifecycleConversationHint = {
  hasInboundMessage: boolean;
  /// Free-form session stage (e.g. SELECT_DATES, SELECT_ROOM, AWAIT_CONFIRMATION).
  /// Used to differentiate INQUIRY → SEARCHING_HOTELS → VIEWING_PROPERTY → BOOKING_IN_PROGRESS.
  sessionStage?: string | null;
};

export type ComputeGuestLifecycleStateInput = {
  guest: LifecycleGuestShape | null | undefined;
  bookings: LifecycleBookingShape[];
  conversation?: LifecycleConversationHint;
  now?: Date;
};

export type ComputeGuestLifecycleStateResult = {
  state: GuestLifecycleState;
  /// The booking the state is anchored to (e.g. the most recent CHECKED_IN
  /// for IN_HOUSE; the next upcoming CONFIRMED for PRE_ARRIVAL/CONFIRMED).
  /// `null` when the state is conversation-only (UNKNOWN/INQUIRY/SEARCHING/...).
  anchorBooking: LifecycleBookingShape | null;
  /// True when the guest has at least one prior completed stay at this hotel
  /// (orthogonal to the current state — useful for VIP / repeat-promo logic).
  isReturning: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const PRE_ARRIVAL_WINDOW_MS = 7 * DAY_MS;
const POST_STAY_WINDOW_MS = 30 * DAY_MS;

function isCheckinEqOrBefore(checkIn: Date, now: Date): boolean {
  return checkIn.getTime() <= now.getTime();
}

function isCheckoutAfter(checkOut: Date, now: Date): boolean {
  return checkOut.getTime() > now.getTime();
}

/**
 * Derive the relationship-level lifecycle state from the guest's bookings
 * (and optional conversation hint). Pure function: callers pass loaded data,
 * we never query the DB here.
 */
export function computeGuestLifecycleState(input: ComputeGuestLifecycleStateInput): ComputeGuestLifecycleStateResult {
  const now = input.now ?? new Date();
  const bookings = (input.bookings ?? []).slice();
  const isReturning = (input.guest?.priorStaysCount ?? 0) > 0;

  // --- Operational anchor states (require an existing booking) -------------
  const checkedIn = bookings
    .filter(
      (b) =>
        b.status === BookingStatus.CHECKED_IN &&
        isCheckinEqOrBefore(b.checkIn, now) &&
        isCheckoutAfter(b.checkOut, now)
    )
    .sort((a, b) => a.checkIn.getTime() - b.checkIn.getTime());
  if (checkedIn.length > 0) {
    return { state: "IN_HOUSE", anchorBooking: checkedIn[0], isReturning };
  }

  // CHECKED_IN booking but checkOut is today/past — staff hasn't checked them
  // out yet. Treat as IN_HOUSE for outreach correctness; staff still sees the
  // operational status separately.
  const stillCheckedIn = bookings
    .filter((b) => b.status === BookingStatus.CHECKED_IN)
    .sort((a, b) => b.checkIn.getTime() - a.checkIn.getTime());
  if (stillCheckedIn.length > 0) {
    return { state: "CHECKED_IN", anchorBooking: stillCheckedIn[0], isReturning };
  }

  // Recent checkout (POST_STAY window).
  const recentCheckouts = bookings
    .filter(
      (b) =>
        (b.status === BookingStatus.CHECKED_IN || b.status === BookingStatus.CONFIRMED) &&
        b.checkOut.getTime() <= now.getTime() &&
        now.getTime() - b.checkOut.getTime() <= POST_STAY_WINDOW_MS
    )
    .sort((a, b) => b.checkOut.getTime() - a.checkOut.getTime());
  if (recentCheckouts.length > 0) {
    return { state: "POST_STAY", anchorBooking: recentCheckouts[0], isReturning };
  }

  // Confirmed but not yet checked-in. PRE_ARRIVAL within 7 days, otherwise CONFIRMED.
  const upcomingConfirmed = bookings
    .filter(
      (b) =>
        (b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.PENDING) &&
        b.checkIn.getTime() > now.getTime()
    )
    .sort((a, b) => a.checkIn.getTime() - b.checkIn.getTime());
  if (upcomingConfirmed.length > 0) {
    const next = upcomingConfirmed[0];
    if (next.checkIn.getTime() - now.getTime() <= PRE_ARRIVAL_WINDOW_MS) {
      return { state: "PRE_ARRIVAL", anchorBooking: next, isReturning };
    }
    return { state: "CONFIRMED", anchorBooking: next, isReturning };
  }

  // No active or upcoming booking. Older completed bookings flip the guest to
  // CHECKED_OUT (single most-recent stay) so post-stay outreach can still
  // anchor on a booking even past the 30-day window.
  const olderCompleted = bookings
    .filter((b) => b.status === BookingStatus.CHECKED_IN || b.status === BookingStatus.CONFIRMED)
    .sort((a, b) => b.checkOut.getTime() - a.checkOut.getTime());
  if (olderCompleted.length > 0 && olderCompleted[0].checkOut.getTime() <= now.getTime()) {
    return { state: "CHECKED_OUT", anchorBooking: olderCompleted[0], isReturning };
  }

  // --- Pre-booking conversation states -------------------------------------
  const stage = (input.conversation?.sessionStage ?? "").toUpperCase();
  const hasInbound = Boolean(input.conversation?.hasInboundMessage);

  if (!input.guest || !hasInbound) {
    return { state: "UNKNOWN_GUEST", anchorBooking: null, isReturning };
  }

  if (
    stage.includes("ROOM") ||
    stage.includes("PAY") ||
    stage.includes("CONFIRM") ||
    stage.includes("AWAIT_CONFIRMATION") ||
    stage.includes("BOOKING")
  ) {
    return { state: "BOOKING_IN_PROGRESS", anchorBooking: null, isReturning };
  }

  if (stage.includes("DATE") || stage.includes("AVAILABILITY") || stage.includes("OFFER")) {
    return { state: "VIEWING_PROPERTY", anchorBooking: null, isReturning };
  }

  if (stage.includes("SEARCH") || stage.includes("CITY")) {
    return { state: "SEARCHING_HOTELS", anchorBooking: null, isReturning };
  }

  // First inbound message, no booking, no booking-stage hint — pure inquiry.
  if (isReturning) {
    return { state: "RETURNING_GUEST", anchorBooking: null, isReturning };
  }
  return { state: "INQUIRY", anchorBooking: null, isReturning };
}

/**
 * Friendly badge label for staff-facing UI. Keep short — the conversation
 * page header is tight on space.
 */
export function lifecycleStateLabel(state: GuestLifecycleState): string {
  switch (state) {
    case "UNKNOWN_GUEST":
      return "Unknown";
    case "INQUIRY":
      return "Inquiry";
    case "SEARCHING_HOTELS":
      return "Searching";
    case "VIEWING_PROPERTY":
      return "Viewing";
    case "BOOKING_IN_PROGRESS":
      return "Booking…";
    case "CONFIRMED":
      return "Confirmed";
    case "PRE_ARRIVAL":
      return "Pre-arrival";
    case "CHECKED_IN":
      return "Checked-in";
    case "IN_HOUSE":
      return "In-house";
    case "CHECKED_OUT":
      return "Checked-out";
    case "POST_STAY":
      return "Post-stay";
    case "RETURNING_GUEST":
      return "Returning";
  }
}

/**
 * UI badge severity for the staff-facing conversation page. Maps to the
 * existing `.badge` / `.badge ok|alert|pending` classes in admin.ts.
 */
export function lifecycleBadgeClass(state: GuestLifecycleState): "ok" | "pending" | "alert" | "" {
  switch (state) {
    case "IN_HOUSE":
    case "CHECKED_IN":
      return "ok";
    case "PRE_ARRIVAL":
    case "BOOKING_IN_PROGRESS":
    case "POST_STAY":
      return "pending";
    case "UNKNOWN_GUEST":
      return "alert";
    default:
      return "";
  }
}
