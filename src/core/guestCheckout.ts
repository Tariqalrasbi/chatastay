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
    }
  | { ok: false; code: string; message: string };

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
  if (booking.paymentStatus === PaymentStatus.PENDING || booking.paymentStatus === PaymentStatus.REQUIRES_ACTION) {
    return {
      ok: false,
      code: "payment_processing",
      message:
        "Checkout cannot be completed while payment is still processing. Please wait for payment confirmation or settle manually."
    };
  }
  const { folio, isPaid } = await getBookingCheckoutSettlementSnapshot(prisma, booking);
  if (!isPaid || folio.outstandingBalance > 0.005) {
    return {
      ok: false,
      code: "outstanding_balance",
      message: `Checkout cannot be completed because this reservation still has an outstanding balance of ${folio.currency} ${folio.outstandingBalance.toFixed(3)}. Please add payment or settle the invoice first.`
    };
  }
  const guestName = booking.guest.fullName || booking.guest.phoneE164 || "Guest";
  return {
    ok: true,
    booking: {
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
    },
    folio,
    paidAmount: folio.paidBalance
  };
}

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
};

export type PerformGuestCheckoutOk = {
  ok: true;
  auditBookingId: string | null;
  roomUnitId: string;
  departureDateKey: string;
  hkFromCheckout: { created: boolean; taskId: string | null };
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

      await tx.booking.update({
        where: { id: booking.id },
        data: {
          checkOut: newCheckOut,
          nights: newNights,
          totalAmount: newTotal
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
    hkFromCheckout
  };
}
