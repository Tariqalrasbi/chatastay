import {
  FolioOutletCategory,
  FolioPostingTarget,
  FolioTransactionType,
  FolioTxnPaymentStatus,
  PaymentStatus
} from "@prisma/client";
import { prisma } from "../db";
import { getFbFolioForBooking } from "./fbFolio";

export type RoomUnitFolioSummary = {
  currency: string;
  roomCharges: number;
  fbMenuSubtotal: number;
  folioChargesSubtotal: number;
  folioAdjustmentsSubtotal: number;
  folioPaymentsTotal: number;
  fnbExtrasTotal: number;
  totalCharges: number;
  amountPaidBooking: number;
  amountPaidFolio: number;
  totalPaid: number;
  outstandingBalance: number;
};

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Room-unit guest account view. Room charges use Booking.totalAmount; F&B from FbOrder; folio lines from FolioTransaction.
 * Booking has no stored folio balance field — totals are always derived here.
 */
export async function computeRoomUnitFolioSummary(params: {
  hotelId: string;
  currency: string;
  booking: { id: string; totalAmount: number; paymentStatus?: PaymentStatus } | null;
  paymentIntentsSucceededTotal: number;
}): Promise<RoomUnitFolioSummary> {
  const { hotelId, currency, booking, paymentIntentsSucceededTotal } = params;
  const roomCharges = booking ? booking.totalAmount : 0;
  let fbMenuSubtotal = 0;
  if (booking) {
    const fb = await getFbFolioForBooking(booking.id);
    fbMenuSubtotal = fb.subtotal;
  }

  const txns = booking
    ? await prisma.folioTransaction.findMany({
        where: { hotelId, bookingId: booking.id }
      })
    : [];

  let folioChargesSubtotal = 0;
  let folioAdjustmentsSubtotal = 0;
  let folioPaymentsTotal = 0;
  for (const t of txns) {
    if (t.voidedAt || t.isVoided) continue;
    if (t.transactionType === FolioTransactionType.PAYMENT) {
      folioPaymentsTotal += t.grossAmount;
    } else if (t.transactionType === FolioTransactionType.ADJUSTMENT) {
      folioAdjustmentsSubtotal += t.netAmount;
    } else if (t.transactionType === FolioTransactionType.DISCOUNT) {
      folioAdjustmentsSubtotal += t.netAmount;
    } else if (t.transactionType === FolioTransactionType.REFUND) {
      folioPaymentsTotal -= t.grossAmount;
    } else {
      folioChargesSubtotal += t.netAmount;
    }
  }

  folioChargesSubtotal = round2(folioChargesSubtotal);
  folioAdjustmentsSubtotal = round2(folioAdjustmentsSubtotal);
  folioPaymentsTotal = round2(folioPaymentsTotal);
  const fnbExtrasTotal = round2(fbMenuSubtotal + folioChargesSubtotal);
  const totalCharges = round2(roomCharges + fnbExtrasTotal + folioAdjustmentsSubtotal);
  const amountPaidFolio = folioPaymentsTotal;
  let amountPaidBooking = round2(paymentIntentsSucceededTotal);
  if (
    booking?.paymentStatus === PaymentStatus.SUCCEEDED &&
    amountPaidBooking === 0 &&
    amountPaidFolio === 0 &&
    totalCharges > 0
  ) {
    amountPaidBooking = totalCharges;
  }
  const totalPaid = round2(amountPaidBooking + amountPaidFolio);
  const outstandingBalance = Math.max(0, round2(totalCharges - totalPaid));

  return {
    currency,
    roomCharges: round2(roomCharges),
    fbMenuSubtotal: round2(fbMenuSubtotal),
    folioChargesSubtotal,
    folioAdjustmentsSubtotal,
    folioPaymentsTotal,
    fnbExtrasTotal,
    totalCharges,
    amountPaidBooking,
    amountPaidFolio,
    totalPaid,
    outstandingBalance
  };
}

export function mapChargeCategoryToFolio(
  category: string
): { outletCategory: FolioOutletCategory; transactionType: FolioTransactionType } {
  switch (category) {
    case "CAFE":
      return { outletCategory: FolioOutletCategory.CAFE, transactionType: FolioTransactionType.FNB_CHARGE };
    case "ACTIVITY":
      return { outletCategory: FolioOutletCategory.ACTIVITY, transactionType: FolioTransactionType.ACTIVITY_CHARGE };
    case "ROOM_SERVICE":
      return { outletCategory: FolioOutletCategory.ROOM_SERVICE, transactionType: FolioTransactionType.OTHER_SERVICE_CHARGE };
    case "OTHER_SERVICE":
      return { outletCategory: FolioOutletCategory.OTHER, transactionType: FolioTransactionType.OTHER_SERVICE_CHARGE };
    case "CUSTOM":
      return { outletCategory: FolioOutletCategory.OTHER, transactionType: FolioTransactionType.OTHER_SERVICE_CHARGE };
    case "RESTAURANT":
    default:
      return { outletCategory: FolioOutletCategory.RESTAURANT, transactionType: FolioTransactionType.FNB_CHARGE };
  }
}

export function parsePostingTarget(raw: string): FolioPostingTarget {
  if (raw === "GUEST_FOLIO") return FolioPostingTarget.GUEST_FOLIO;
  if (raw === "ROOM_ACCOUNT") return FolioPostingTarget.ROOM_ACCOUNT;
  return FolioPostingTarget.BOOKING_ACCOUNT;
}
