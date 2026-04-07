import type { BookingStatus, Prisma, PrismaClient } from "@prisma/client";

export type RecordBookingStatusChangeParams = {
  hotelId: string;
  bookingId: string;
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  source?: string;
  actorUserId?: string | null;
  note?: string | null;
};

/** Appends one row when the booking lifecycle status changes. No-op if from === to. */
export async function recordBookingStatusChange(
  db: Prisma.TransactionClient | PrismaClient,
  params: RecordBookingStatusChangeParams
): Promise<void> {
  if (params.fromStatus === params.toStatus) return;
  await db.bookingStatusHistory.create({
    data: {
      hotelId: params.hotelId,
      bookingId: params.bookingId,
      fromStatus: params.fromStatus ?? undefined,
      toStatus: params.toStatus,
      source: params.source ?? "SYSTEM",
      actorUserId: params.actorUserId ?? undefined,
      note: params.note ?? undefined
    }
  });
}
