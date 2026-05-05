import type { PaymentStatus } from "@prisma/client";
import { computeRoomUnitFolioSummary, type RoomUnitFolioSummary } from "./roomUnitFolio";

export type CheckInBillBookingSlice = {
  id: string;
  referenceCode: string | null;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  totalAmount: number;
  currency: string;
  paymentStatus: PaymentStatus;
  mealPlan: string | null;
};

export async function loadFolioSummaryForCheckInWhatsApp(params: {
  hotelId: string;
  booking: CheckInBillBookingSlice;
  paymentIntentsSucceededTotal: number;
}): Promise<RoomUnitFolioSummary> {
  return computeRoomUnitFolioSummary({
    hotelId: params.hotelId,
    currency: params.booking.currency,
    booking: {
      id: params.booking.id,
      totalAmount: params.booking.totalAmount,
      paymentStatus: params.booking.paymentStatus
    },
    paymentIntentsSucceededTotal: params.paymentIntentsSucceededTotal
  });
}

/**
 * Plain-text bill for WhatsApp after check-in (no guest-facing PDF URL in this build).
 */
export function formatCheckInBillWhatsAppText(params: {
  hotelName: string;
  roomName: string;
  guestName: string;
  booking: CheckInBillBookingSlice;
  folio: RoomUnitFolioSummary;
}): string {
  const { hotelName, roomName, guestName, booking, folio } = params;
  const ref = booking.referenceCode ? ` · Ref ${booking.referenceCode}` : "";
  const mp = (booking.mealPlan ?? "NONE").toUpperCase();
  const mealLine =
    mp === "NONE"
      ? "Meal plan: Room only (room rate includes no meals)"
      : mp === "BREAKFAST"
        ? "Meal plan: Breakfast package (board charges in room total)"
        : mp === "HALF_BOARD"
          ? "Meal plan: Half board (board charges in room total)"
          : mp === "FULL_BOARD"
            ? "Meal plan: Full board (board charges in room total)"
            : `Meal plan: ${mp}`;

  const cin = booking.checkIn.toISOString().slice(0, 16).replace("T", " ");
  const cout = booking.checkOut.toISOString().slice(0, 10);

  return [
    `*${hotelName}* — you're checked in${ref}`,
    `Guest: ${guestName}`,
    `Room: ${roomName}`,
    `Check-in: ${cin} · Check-out (date): ${cout} · Nights: ${booking.nights}`,
    mealLine,
    "",
    "*Account summary*",
    `Room & package total: ${folio.roomCharges.toFixed(2)} ${folio.currency}`,
    `F&B & posted extras: ${folio.fnbExtrasTotal.toFixed(2)} ${folio.currency}`,
    `Adjustments: ${folio.folioAdjustmentsSubtotal.toFixed(2)} ${folio.currency}`,
    `*Total charges:* ${folio.totalCharges.toFixed(2)} ${folio.currency}`,
    `Paid (booking + folio): ${folio.totalPaid.toFixed(2)} ${folio.currency}`,
    `*Outstanding:* ${folio.outstandingBalance.toFixed(2)} ${folio.currency}`,
    "",
    "Charges post to your in-room folio as you order. For a printed invoice, ask reception."
  ].join("\n");
}
