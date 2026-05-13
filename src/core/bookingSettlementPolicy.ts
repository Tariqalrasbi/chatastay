import { ChannelProvider, PaymentStatus } from "@prisma/client";

/**
 * PMS-style settlement policy. Decides whether a booking is allowed to check
 * out with an outstanding folio balance (B2B / tour-co / OTA / corporate /
 * email-confirmed bookings) without requiring an explicit manager override.
 *
 * Reuses the existing PaymentStatus enum (LPO + FRIENDS_TRANSFER already exist
 * for this exact purpose) and the per-room-unit registration card's `bookedBy`
 * audit field. No schema changes.
 */

export type SettlementPayerType =
  | "GUEST"
  | "TOUR_COMPANY"
  | "TRAVEL_AGENT"
  | "OTA"
  | "CORPORATE"
  | "OTHER";

export type SettlementDecision = {
  /** True when checkout with an outstanding balance is allowed without a manager-approval modal. */
  allowed: boolean;
  /** True when checkout requires explicit manager / authorized approval (reason + manager id captured in audit). */
  requiresApproval: boolean;
  /** Suggested payer type for the invoice recipient. */
  payerHint: SettlementPayerType;
  /** Suggested default due-date offset in days (used by the UI as a default for the date picker). */
  defaultDueDays: number;
  /** Short human reason — surfaced in the audit log + outstanding-account row. */
  reasonHint: string;
};

const OTA_CHANNELS: ReadonlySet<ChannelProvider> = new Set<ChannelProvider>([
  ChannelProvider.BOOKING_COM,
  ChannelProvider.AIRBNB,
  ChannelProvider.EXPEDIA,
  ChannelProvider.CHATASTAY_MARKETPLACE
]);

/**
 * Free-form `bookedBy` value persisted on the room-unit registration card
 * (admin.ts manual check-in form). Stored as audit metadata so we keep the
 * string union loose — extra unknown values just fall through to GUEST.
 */
export type BookedByHint =
  | "WALK_IN"
  | "DIRECT"
  | "OTAS"
  | "TOUR_COMPANY"
  | "TRAVEL_AGENT"
  | "CORPORATE"
  | "PHONE"
  | "WHATSAPP"
  | "EMAIL"
  | "FRIEND_GIFT"
  | string;

export function canCheckoutWithOutstanding(params: {
  source: ChannelProvider;
  paymentStatus: PaymentStatus;
  bookedBy?: BookedByHint | null;
}): SettlementDecision {
  const bookedBy = (params.bookedBy ?? "").toUpperCase();

  // PaymentStatus.LPO + FRIENDS_TRANSFER already imply a finance-follow-up
  // agreement — let those bookings depart without a second approval click.
  if (
    params.paymentStatus === PaymentStatus.LPO ||
    params.paymentStatus === PaymentStatus.FRIENDS_TRANSFER
  ) {
    return {
      allowed: true,
      requiresApproval: false,
      payerHint:
        params.paymentStatus === PaymentStatus.LPO ? "CORPORATE" : "GUEST",
      defaultDueDays: 7,
      reasonHint:
        params.paymentStatus === PaymentStatus.LPO
          ? "Local Purchase Order (B2B / company billing)"
          : "Manual transfer reconciliation"
    };
  }

  if (OTA_CHANNELS.has(params.source) || bookedBy === "OTAS") {
    return {
      allowed: true,
      requiresApproval: false,
      payerHint: "OTA",
      defaultDueDays: 14,
      reasonHint: "OTA booking — channel manager settles on the OTA's billing cycle"
    };
  }

  if (bookedBy === "TOUR_COMPANY") {
    return {
      allowed: true,
      requiresApproval: false,
      payerHint: "TOUR_COMPANY",
      defaultDueDays: 7,
      reasonHint: "Tour company booking — invoice the operator after checkout"
    };
  }

  if (bookedBy === "TRAVEL_AGENT") {
    return {
      allowed: true,
      requiresApproval: false,
      payerHint: "TRAVEL_AGENT",
      defaultDueDays: 14,
      reasonHint: "Travel agent booking — agent settles per agreement"
    };
  }

  if (params.source === ChannelProvider.CORPORATE || bookedBy === "CORPORATE") {
    return {
      allowed: true,
      requiresApproval: false,
      payerHint: "CORPORATE",
      defaultDueDays: 14,
      reasonHint: "Corporate booking — invoice the company after checkout"
    };
  }

  if (bookedBy === "EMAIL") {
    return {
      allowed: true,
      requiresApproval: false,
      payerHint: "OTHER",
      defaultDueDays: 7,
      reasonHint: "Email-confirmed booking — manual follow-up on agreed terms"
    };
  }

  // Direct / walk-in / WhatsApp guests must be fully paid before checkout.
  // Allow a controlled override, but require explicit reason + approving staff.
  return {
    allowed: false,
    requiresApproval: true,
    payerHint: "GUEST",
    defaultDueDays: 3,
    reasonHint: "Delayed payment approved by management"
  };
}

export function settlementPayerLabel(p: SettlementPayerType): string {
  switch (p) {
    case "TOUR_COMPANY":
      return "Tour company";
    case "TRAVEL_AGENT":
      return "Travel agent";
    case "OTA":
      return "OTA channel";
    case "CORPORATE":
      return "Company / corporate";
    case "OTHER":
      return "Other";
    case "GUEST":
    default:
      return "Guest";
  }
}

export function isPostStaySettlementPaymentStatus(s: PaymentStatus): boolean {
  return s === PaymentStatus.LPO || s === PaymentStatus.FRIENDS_TRANSFER;
}
