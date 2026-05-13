import {
  BookingStatus,
  HousekeepingTaskSource,
  PaymentStatus,
  Prisma
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { releaseInventoryForStayRange } from "./bookingService";
import { displayBookingReference } from "./bookingReference";
import { getFolioSummary, type FolioSummaryDto } from "./folioService";
import { writeManualRoomStatusToNotes } from "./roomBoardNotes";
import { round2 } from "./roomUnitFolio";
import { startOfDay } from "./availability";
import {
  canCheckoutWithOutstanding,
  type SettlementDecision,
  type SettlementPayerType
} from "./bookingSettlementPolicy";

export type EnsureHkCleaningFn = (
  tx: Prisma.TransactionClient,
  params: {
    hotelId: string;
    roomUnitId: string;
    source: typeof HousekeepingTaskSource.CHECKOUT;
    bookingId?: string | null;
    createdByUserId?: string | null;
    notes?: string | null;
  }
) => Promise<{ created: boolean; taskId: string | null }>;

export async function getBookingCheckoutSettlementSnapshot(
  prisma: PrismaClient,
  booking: { id: string; hotelId: string; totalAmount: number; currency: string; paymentStatus: PaymentStatus }
): Promise<{ folio: FolioSummaryDto; isPaid: boolean }> {
  const paidAgg = await prisma.paymentIntent.aggregate({
    where: { hotelId: booking.hotelId, bookingId: booking.id, status: PaymentStatus.SUCCEEDED },
    _sum: { amount: true }
  });
  const folio = await getFolioSummary({
    hotelId: booking.hotelId,
    bookingId: booking.id,
    bookingTotalAmount: booking.totalAmount,
    currency: booking.currency,
    paymentIntentsSucceededTotal: round2(paidAgg._sum.amount ?? 0)
  });
  const isPaid = folio.outstandingBalance <= 0.005 || booking.paymentStatus === PaymentStatus.SUCCEEDED;
  return { folio, isPaid };
}

async function hasNonTerminalBookingPaymentIntents(prisma: PrismaClient, bookingId: string): Promise<boolean> {
  const n = await prisma.paymentIntent.count({
    where: {
      bookingId,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.REQUIRES_ACTION] }
    }
  });
  return n > 0;
}

export type GuestCheckoutEligibility =
  | {
      ok: true;
      booking: {
        id: string;
        hotelId: string;
        roomUnitId: string;
        guestName: string;
        referenceDisplay: string;
        checkIn: Date;
        checkOut: Date;
        nights: number;
        totalAmount: number;
        currency: string;
        paymentStatus: PaymentStatus;
        roomUnitName: string | null;
      };
      folio: FolioSummaryDto;
      paidAmount: number;
      /**
       * When the folio is in deficit AND the booking source / payment status
       * agreement allows post-stay settlement (LPO, OTA, tour-co, corporate,
       * etc.) we still return ok:true so the front-desk modal can offer the
       * "Checkout with outstanding balance" path. UI must capture reason/due.
       */
      outstanding?: {
        amount: number;
        currency: string;
        policy: SettlementDecision;
      };
      /**
       * Guest overpaid (paid > total). Render a "credit / refund due" path on
       * the checkout modal so receptionists can record the refund.
       */
      creditDue?: { amount: number; currency: string };
    }
  | { ok: false; code: string; message: string };

/**
 * Looks up the most recent registration card `bookedBy` value the front desk
 * captured on this room unit. Stored as audit metadata (AuditLog rows of action
 * `ROOM_UNIT_GUEST_DETAILS`) so we can read it back without a schema change.
 */
async function loadBookedByHint(
  prisma: PrismaClient,
  hotelId: string,
  roomUnitId: string | null
): Promise<string | null> {
  if (!roomUnitId) return null;
  try {
    const row = await prisma.auditLog.findFirst({
      where: {
        hotelId,
        action: "ROOM_UNIT_GUEST_DETAILS",
        entityType: "RoomUnit",
        entityId: roomUnitId
      },
      orderBy: { createdAt: "desc" },
      select: { metadataJson: true }
    });
    if (!row?.metadataJson) return null;
    let meta: unknown;
    try {
      meta = JSON.parse(row.metadataJson);
    } catch {
      return null;
    }
    if (!meta || typeof meta !== "object") return null;
    const raw = (meta as Record<string, unknown>).bookedBy;
    return typeof raw === "string" ? raw : null;
  } catch {
    return null;
  }
}

export async function evaluateGuestCheckoutEligibility(
  prisma: PrismaClient,
  hotelId: string,
  bookingId: string
): Promise<GuestCheckoutEligibility> {
  const id = String(bookingId ?? "").trim();
  if (!id) {
    return { ok: false, code: "missing_id", message: "Reservation reference is missing." };
  }
  const booking = await prisma.booking.findFirst({
    where: { id, hotelId },
    include: { guest: true, roomUnit: { select: { name: true } } }
  });
  if (!booking) {
    return { ok: false, code: "not_found", message: "Reservation was not found for this hotel." };
  }
  if (booking.status !== BookingStatus.CONFIRMED && booking.status !== BookingStatus.CHECKED_IN) {
    return {
      ok: false,
      code: "bad_status",
      message: "This reservation is not in a state that allows checkout (already cancelled or not active)."
    };
  }
  if (!booking.roomUnitId) {
    return {
      ok: false,
      code: "no_room",
      message: "This reservation has no room assigned. Assign a room before checkout."
    };
  }
  if (await hasNonTerminalBookingPaymentIntents(prisma, booking.id)) {
    return {
      ok: false,
      code: "payment_processing",
      message:
        "Checkout cannot be completed while payment is still processing. Please wait for payment confirmation or settle manually."
    };
  }
  const { folio } = await getBookingCheckoutSettlementSnapshot(prisma, booking);
  const guestName = booking.guest.fullName || booking.guest.phoneE164 || "Guest";
  const bookingDto = {
    id: booking.id,
    hotelId: booking.hotelId,
    roomUnitId: booking.roomUnitId,
    guestName,
    referenceDisplay: displayBookingReference(booking),
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    nights: booking.nights,
    totalAmount: booking.totalAmount,
    currency: booking.currency,
    paymentStatus: booking.paymentStatus,
    roomUnitName: booking.roomUnit?.name ?? null
  } as const;

  // Credit balance (overpaid). Folio summary clamps to 0; recompute the raw
  // signed delta so the UI can surface a refund-due path.
  const signedBalance = round2(folio.totalCharges - folio.paidBalance);
  if (signedBalance < -0.005) {
    return {
      ok: true,
      booking: bookingDto,
      folio,
      paidAmount: folio.paidBalance,
      creditDue: { amount: Math.abs(signedBalance), currency: folio.currency }
    };
  }

  const isPaid = folio.outstandingBalance <= 0.005;
  if (isPaid) {
    return { ok: true, booking: bookingDto, folio, paidAmount: folio.paidBalance };
  }

  // Outstanding balance — see if the booking source / payment-status agreement
  // permits post-stay settlement. If so we still return ok:true and let the UI
  // capture reason + due-date + payer before completing checkout.
  const bookedBy = await loadBookedByHint(prisma, hotelId, booking.roomUnitId);
  const policy = canCheckoutWithOutstanding({
    source: booking.source,
    paymentStatus: booking.paymentStatus,
    bookedBy
  });
  if (
    booking.paymentStatus !== PaymentStatus.PENDING &&
    booking.paymentStatus !== PaymentStatus.REQUIRES_ACTION
  ) {
    // Already in a post-stay-eligible state (LPO / FRIENDS_TRANSFER / etc.) —
    // surface the outstanding path so checkout can complete.
    return {
      ok: true,
      booking: bookingDto,
      folio,
      paidAmount: folio.paidBalance,
      outstanding: {
        amount: folio.outstandingBalance,
        currency: folio.currency,
        policy
      }
    };
  }
  if (policy.allowed || policy.requiresApproval) {
    // policy.allowed → caller can call performGuestCheckout with allowOutstanding directly.
    // policy.requiresApproval → caller must show a manager-approval modal first.
    return {
      ok: true,
      booking: bookingDto,
      folio,
      paidAmount: folio.paidBalance,
      outstanding: {
        amount: folio.outstandingBalance,
        currency: folio.currency,
        policy
      }
    };
  }
  return {
    ok: false,
    code: "outstanding_balance",
    message: `Checkout cannot be completed because this reservation still has an outstanding balance of ${folio.currency} ${folio.outstandingBalance.toFixed(3)}. Please add payment or settle the invoice first.`
  };
}

export type OutstandingCheckoutDetails = {
  reason: string;
  dueDate: Date | null;
  payerType: SettlementPayerType;
  approvedByStaffId?: string | null;
  approvedByEmail?: string | null;
  policySource: "POLICY" | "MANAGER_OVERRIDE";
};

export type PerformGuestCheckoutParams = {
  hotelId: string;
  bookingId: string;
  departureDate: Date;
  departureTimeRaw?: string;
  departureReason?: string;
  discountRequested?: number;
  executedByEmail: string;
  staffId?: string | null;
  ensureHkTask: EnsureHkCleaningFn;
  /**
   * When set, checkout proceeds even if the folio still has an outstanding
   * balance. Booking.paymentStatus is moved to LPO (if not already a
   * post-stay-settlement status) and an audit row is written so finance has
   * a paper trail.
   */
  allowOutstanding?: OutstandingCheckoutDetails | null;
};

export type PerformGuestCheckoutOk = {
  ok: true;
  auditBookingId: string | null;
  roomUnitId: string;
  departureDateKey: string;
  hkFromCheckout: { created: boolean; taskId: string | null };
  /** Set when checkout completed with an outstanding folio. */
  outstanding?: {
    amount: number;
    currency: string;
    paymentStatus: PaymentStatus;
    dueDate: Date | null;
    payerType: SettlementPayerType;
    reason: string;
  } | null;
};

export type PerformGuestCheckoutResult = PerformGuestCheckoutOk | { ok: false; message: string };

/**
 * Single checkout path: validate folio/payment, prorate booking if early checkout, mark room for housekeeping.
 * Caller should log audit, send invoice, and notify housekeeping after success.
 */
export async function performGuestCheckout(
  prisma: PrismaClient,
  params: PerformGuestCheckoutParams
): Promise<PerformGuestCheckoutResult> {
  const pre = await evaluateGuestCheckoutEligibility(prisma, params.hotelId, params.bookingId);
  if (!pre.ok) {
    return { ok: false, message: pre.message };
  }
  const discountRequested = Number.isFinite(params.discountRequested) && (params.discountRequested ?? 0) > 0 ? params.discountRequested! : 0;
  const departureDate = startOfDay(params.departureDate);

  let auditBookingId: string | null = null;
  let hkFromCheckout: { created: boolean; taskId: string | null } = { created: false, taskId: null };
  let roomUnitIdForResult = "";
  let departureDateKey = "";
  let outstandingResult: PerformGuestCheckoutOk["outstanding"] = null;

  try {
    await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findFirst({
        where: {
          id: params.bookingId,
          hotelId: params.hotelId,
          roomUnitId: { not: null },
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] }
        }
      });
      if (!booking || !booking.roomUnitId) {
        throw new Error("Reservation is no longer eligible for checkout.");
      }
      roomUnitIdForResult = booking.roomUnitId;

      const checkInDay = startOfDay(booking.checkIn);
      const oldCheckOut = startOfDay(booking.checkOut);
      const newCheckOut = departureDate;
      if (newCheckOut.getTime() < checkInDay.getTime()) {
        throw new Error("Departure cannot be before check-in.");
      }
      if (newCheckOut.getTime() > oldCheckOut.getTime()) {
        throw new Error("Departure cannot be after the scheduled checkout date.");
      }
      const priorNights = Math.round((oldCheckOut.getTime() - checkInDay.getTime()) / 86400000);
      if (priorNights < 1) {
        throw new Error("Could not determine stay length from this booking.");
      }
      const newNights = Math.round((newCheckOut.getTime() - checkInDay.getTime()) / 86400000);
      if (newNights < 0) throw new Error("Invalid stay length after checkout.");

      const proRated = Math.round(((booking.totalAmount * newNights) / priorNights) * 1000) / 1000;
      const cappedDiscount = Math.min(discountRequested, proRated);
      const newTotal = Math.max(0, Math.round((proRated - cappedDiscount) * 1000) / 1000);

      // If the caller approved post-stay settlement, flip paymentStatus to LPO
      // (B2B / finance follow-up) so reporting and the briefing widget can find
      // the row. Leave FRIENDS_TRANSFER alone — it's also a valid post-stay
      // state. Don't touch SUCCEEDED.
      const shouldFlipToLpo =
        Boolean(params.allowOutstanding) &&
        booking.paymentStatus !== PaymentStatus.SUCCEEDED &&
        booking.paymentStatus !== PaymentStatus.LPO &&
        booking.paymentStatus !== PaymentStatus.FRIENDS_TRANSFER;

      await tx.booking.update({
        where: { id: booking.id },
        data: {
          checkOut: newCheckOut,
          nights: newNights,
          totalAmount: newTotal,
          ...(shouldFlipToLpo ? { paymentStatus: PaymentStatus.LPO } : {})
        }
      });

      if (newCheckOut.getTime() < oldCheckOut.getTime()) {
        await releaseInventoryForStayRange({
          tx,
          roomTypeId: booking.roomTypeId,
          start: newCheckOut,
          endExclusive: oldCheckOut,
          rooms: 1
        });
      }

      auditBookingId = booking.id;
      departureDateKey = `${newCheckOut.getFullYear()}-${String(newCheckOut.getMonth() + 1).padStart(2, "0")}-${String(newCheckOut.getDate()).padStart(2, "0")}`;

      const fresh = await tx.roomUnit.findUnique({ where: { id: booking.roomUnitId }, select: { notes: true } });
      await tx.roomUnit.update({
        where: { id: booking.roomUnitId },
        data: { notes: writeManualRoomStatusToNotes(fresh?.notes, "CLEANING") }
      });
      hkFromCheckout = await params.ensureHkTask(tx, {
        hotelId: params.hotelId,
        roomUnitId: booking.roomUnitId,
        source: HousekeepingTaskSource.CHECKOUT,
        bookingId: booking.id,
        createdByUserId: params.staffId ?? null,
        notes: "Guest departure (manual check-out)"
      });

      if (params.allowOutstanding) {
        // Recompute the folio outstanding after prorate so the value reported
        // to the caller (and persisted in the audit log) reflects what finance
        // actually needs to chase.
        const paidAgg = await tx.paymentIntent.aggregate({
          where: { hotelId: params.hotelId, bookingId: booking.id, status: PaymentStatus.SUCCEEDED },
          _sum: { amount: true }
        });
        const folio = await getFolioSummary({
          hotelId: params.hotelId,
          bookingId: booking.id,
          bookingTotalAmount: newTotal,
          currency: booking.currency,
          paymentIntentsSucceededTotal: round2(paidAgg._sum.amount ?? 0)
        });
        outstandingResult = {
          amount: folio.outstandingBalance,
          currency: folio.currency,
          paymentStatus: shouldFlipToLpo ? PaymentStatus.LPO : booking.paymentStatus,
          dueDate: params.allowOutstanding.dueDate ?? null,
          payerType: params.allowOutstanding.payerType,
          reason: params.allowOutstanding.reason
        };
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Check-out could not be completed.";
    return { ok: false, message: msg };
  }

  return {
    ok: true,
    auditBookingId,
    roomUnitId: roomUnitIdForResult,
    departureDateKey,
    hkFromCheckout,
    outstanding: outstandingResult
  };
}
