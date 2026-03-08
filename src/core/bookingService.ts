import { BookingStatus, ConversationState, PaymentStatus } from "@prisma/client";
import { prisma } from "../db";
import { findAvailableRoomType } from "./availability";

export async function createConfirmedBookingAtomic(params: {
  hotelId: string;
  guestId: string;
  conversationId: string;
  checkIn: Date;
  checkOut: Date;
  guests: number;
  rooms: number;
  currency: string;
}): Promise<{
  bookingId: string;
  roomTypeId: string;
  roomTypeName: string;
  propertyId: string;
  nights: number;
  totalAmount: number;
}> {
  const offer = await findAvailableRoomType({
    hotelId: params.hotelId,
    checkIn: params.checkIn,
    checkOut: params.checkOut,
    guests: params.guests,
    rooms: params.rooms
  });
  if (!offer) {
    throw new Error("No availability for selected dates.");
  }

  const bookingId = `WB-${Date.now().toString(36).toUpperCase()}`;
  await prisma.$transaction(async (tx) => {
    const roomType = await tx.roomType.findFirst({
      where: { id: offer.roomTypeId, hotelId: params.hotelId, isActive: true }
    });
    if (!roomType) {
      throw new Error("Selected room type is no longer available.");
    }

    const overlappingCount = await tx.booking.count({
      where: {
        hotelId: params.hotelId,
        roomTypeId: offer.roomTypeId,
        status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
        checkIn: { lt: params.checkOut },
        checkOut: { gt: params.checkIn }
      }
    });

    const inventoryRows = await tx.inventory.findMany({
      where: { hotelId: params.hotelId, roomTypeId: offer.roomTypeId, date: { gte: params.checkIn, lt: params.checkOut } },
      select: { total: true, reserved: true, closedOut: true }
    });
    const availableRooms = inventoryRows.length
      ? inventoryRows.some((x) => x.closedOut)
        ? 0
        : inventoryRows.reduce((min, row) => Math.min(min, Math.max(0, row.total - row.reserved)), Number.POSITIVE_INFINITY)
      : Math.max(0, roomType.totalInventory - overlappingCount);

    if (availableRooms < params.rooms) {
      throw new Error("Availability changed while confirming booking.");
    }

    await tx.booking.create({
      data: {
        id: bookingId,
        hotelId: params.hotelId,
        propertyId: offer.propertyId,
        roomTypeId: offer.roomTypeId,
        guestId: params.guestId,
        conversationId: params.conversationId,
        checkIn: params.checkIn,
        checkOut: params.checkOut,
        nights: offer.nights,
        adults: params.guests,
        children: 0,
        totalAmount: offer.total,
        currency: params.currency,
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PENDING
      }
    });

    await tx.conversation.update({
      where: { id: params.conversationId },
      data: { state: ConversationState.CONFIRMED, lastMessageAt: new Date() }
    });

    await tx.bookingDraft.updateMany({
      where: { hotelId: params.hotelId, guestId: params.guestId, status: "OPEN" },
      data: { status: "CONFIRMED", bookingId }
    });
  });

  return {
    bookingId,
    roomTypeId: offer.roomTypeId,
    roomTypeName: offer.roomTypeName,
    propertyId: offer.propertyId,
    nights: offer.nights,
    totalAmount: offer.total
  };
}

