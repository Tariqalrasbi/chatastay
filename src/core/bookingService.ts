import {
  BookingStatus,
  ChannelProvider,
  ConversationState,
  HousekeepingTaskStatus,
  PaymentStatus,
  UserRole
} from "@prisma/client";
import { recordBookingStatusChange } from "./bookingStatusHistory";
import { allocateBookingReferenceCode } from "./bookingReference";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db";
import { createRoleRoutedNotification } from "./notifications";
import { refreshGuestSegmentTagsForGuest } from "./guestSegmentation";
import { mergeLightGuestMemoryFromConfirmedBooking } from "./lightGuestMemory";
import { ensureActiveFolio } from "./folioService";
import { addDays, findAvailableRoomType, startOfDay } from "./availability";
import { inventoryDayRangeExclusive } from "./inventoryDate";
import { trackDecisionEventSafe } from "./decisionAnalytics";

type OpsRoomStatus = "AVAILABLE" | "RESERVED" | "OCCUPIED" | "CLEANING" | "MAINTENANCE";

function parseOpsRoomStatusFromNotes(notes: string | null | undefined): OpsRoomStatus | null {
  if (!notes) return null;
  const m = notes.match(/@manual-status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE)@/i);
  return (m?.[1]?.toUpperCase() as OpsRoomStatus | undefined) ?? null;
}

/** Blocks guest assignment when unit is in cleaning or maintenance (room-board [status:] or legacy @manual-status). */
export function isRoomUnitBlockedForGuestAssignment(notes: string | null | undefined): boolean {
  const ops = parseOpsRoomStatusFromNotes(notes);
  if (ops === "CLEANING" || ops === "MAINTENANCE") return true;
  if (!notes) return false;
  const m = notes.match(/\[status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE)\]/i);
  const s = m?.[1]?.toUpperCase();
  return s === "CLEANING" || s === "MAINTENANCE";
}

export async function autoAssignRoomUnitForBookingTx(params: {
  tx: Prisma.TransactionClient;
  hotelId: string;
  roomTypeId: string;
  checkIn: Date;
  checkOut: Date;
  excludeBookingId?: string;
}): Promise<string | null> {
  const units = await params.tx.roomUnit.findMany({
    where: { hotelId: params.hotelId, roomTypeId: params.roomTypeId, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, notes: true }
  });
  if (!units.length) return null;

  const overlaps = await params.tx.booking.findMany({
    where: {
      hotelId: params.hotelId,
      roomTypeId: params.roomTypeId,
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      checkIn: { lt: params.checkOut },
      checkOut: { gt: params.checkIn },
      roomUnitId: { not: null },
      ...(params.excludeBookingId ? { id: { not: params.excludeBookingId } } : {})
    },
    select: { roomUnitId: true }
  });
  const occupied = new Set(overlaps.map((row) => row.roomUnitId).filter((id): id is string => Boolean(id)));
  const candidate = units.find((unit) => {
    if (occupied.has(unit.id)) return false;
    return !isRoomUnitBlockedForGuestAssignment(unit.notes);
  });
  return candidate?.id ?? null;
}

/**
 * Reserves inventory for a confirmed booking: for each night in [checkIn, checkOut),
 * increments Inventory.reserved by `rooms`. Creates Inventory rows if they don't exist
 * (using RoomType.totalInventory as total). Prevents overbooking by ensuring
 * reserved never exceeds total.
 */
export async function reserveInventoryForBooking(params: {
  tx: Prisma.TransactionClient;
  hotelId: string;
  roomTypeId: string;
  propertyId: string;
  checkIn: Date;
  checkOut: Date;
  rooms: number;
}): Promise<void> {
  const { tx, hotelId, roomTypeId, propertyId, checkIn, checkOut, rooms } = params;
  const start = startOfDay(checkIn);
  const end = startOfDay(checkOut);
  let date = new Date(start.getTime());
  while (date.getTime() < end.getTime()) {
    const dr = inventoryDayRangeExclusive(date);
    const existing = await tx.inventory.findFirst({
      where: { hotelId, roomTypeId, date: { gte: dr.gte, lt: dr.lt } },
      select: { id: true, total: true, reserved: true }
    });
    if (existing) {
      const newReserved = Math.min(existing.reserved + rooms, existing.total);
      await tx.inventory.update({
        where: { id: existing.id },
        data: { reserved: newReserved }
      });
    } else {
      const roomType = await tx.roomType.findFirst({
        where: { id: roomTypeId, hotelId },
        select: { totalInventory: true }
      });
      const total = roomType?.totalInventory ?? 1;
      const dayDate = startOfDay(date);
      await tx.inventory.create({
        data: {
          hotelId,
          propertyId,
          roomTypeId,
          date: dayDate,
          total,
          reserved: Math.min(rooms, total)
        }
      });
    }
    date = addDays(date, 1);
  }
}

/** Decrements reserved for each night in [start, endExclusive). Used when shortening a stay. */
export async function releaseInventoryForStayRange(params: {
  tx: Prisma.TransactionClient;
  roomTypeId: string;
  start: Date;
  endExclusive: Date;
  rooms: number;
}): Promise<void> {
  const { tx, roomTypeId, rooms } = params;
  let date = startOfDay(params.start);
  const end = startOfDay(params.endExclusive);
  while (date.getTime() < end.getTime()) {
    const dr = inventoryDayRangeExclusive(date);
    const existing = await tx.inventory.findFirst({
      where: { roomTypeId, date: { gte: dr.gte, lt: dr.lt } },
      select: { id: true, reserved: true }
    });
    if (existing) {
      const newReserved = Math.max(0, existing.reserved - rooms);
      await tx.inventory.update({
        where: { id: existing.id },
        data: { reserved: newReserved }
      });
    }
    date = addDays(date, 1);
  }
}

export async function createConfirmedBookingAtomic(params: {
  hotelId: string;
  guestId: string;
  conversationId: string;
  checkIn: Date;
  checkOut: Date;
  /** Total guests (used for availability); must match adults + children when both are set. */
  guests: number;
  rooms: number;
  currency: string;
  /** When omitted, adults defaults to `guests` and children to 0. */
  adults?: number;
  children?: number;
  /** Distinguishes WhatsApp automation from front-desk / OTA sources. */
  source?: ChannelProvider;
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

  const adults = params.adults ?? params.guests;
  const children = params.children ?? 0;

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

    const stayStart = startOfDay(params.checkIn);
    const stayEnd = startOfDay(params.checkOut);
    const inventoryRows = await tx.inventory.findMany({
      where: { hotelId: params.hotelId, roomTypeId: offer.roomTypeId, date: { gte: stayStart, lt: stayEnd } },
      select: { total: true, reserved: true, closedOut: true }
    });
    const blockedUnits = await tx.roomUnit.count({
      where: {
        hotelId: params.hotelId,
        roomTypeId: offer.roomTypeId,
        isActive: true,
        OR: [{ notes: { contains: "@manual-status:CLEANING@" } }, { notes: { contains: "@manual-status:MAINTENANCE@" } }]
      }
    });
    const baselineAvailableRooms = inventoryRows.length
      ? inventoryRows.some((x) => x.closedOut)
        ? 0
        : inventoryRows.reduce((min, row) => Math.min(min, Math.max(0, row.total - row.reserved)), Number.POSITIVE_INFINITY)
      : Math.max(0, roomType.totalInventory - overlappingCount);
    const availableRooms = Math.max(0, baselineAvailableRooms - blockedUnits);

    if (availableRooms < params.rooms) {
      throw new Error("Availability changed while confirming booking.");
    }

    const roomUnitId = await autoAssignRoomUnitForBookingTx({
      tx,
      hotelId: params.hotelId,
      roomTypeId: offer.roomTypeId,
      checkIn: params.checkIn,
      checkOut: params.checkOut
    });

    const src = params.source ?? ChannelProvider.WHATSAPP;
    const referenceCode = await allocateBookingReferenceCode(tx, {
      hotelId: params.hotelId,
      source: src,
      refDate: new Date()
    });

    await tx.booking.create({
      data: {
        id: bookingId,
        hotelId: params.hotelId,
        propertyId: offer.propertyId,
        roomTypeId: offer.roomTypeId,
        roomUnitId,
        guestId: params.guestId,
        conversationId: params.conversationId,
        checkIn: params.checkIn,
        checkOut: params.checkOut,
        nights: offer.nights,
        adults,
        children,
        totalAmount: offer.total,
        currency: params.currency,
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PENDING,
        source: src,
        referenceCode
      }
    });

    await recordBookingStatusChange(tx, {
      hotelId: params.hotelId,
      bookingId,
      fromStatus: null,
      toStatus: BookingStatus.CONFIRMED,
      source: String(params.source ?? ChannelProvider.DIRECT)
    });

    await ensureActiveFolio(tx, {
      hotelId: params.hotelId,
      bookingId,
      guestId: params.guestId,
      roomUnitId,
      currency: params.currency,
      staffId: null
    });

    await reserveInventoryForBooking({
      tx,
      hotelId: params.hotelId,
      roomTypeId: offer.roomTypeId,
      propertyId: offer.propertyId,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      rooms: params.rooms
    });

    await tx.conversation.update({
      where: { id: params.conversationId },
      data: { state: ConversationState.CONFIRMED, lastMessageAt: new Date(), propertyId: offer.propertyId }
    });

    await tx.bookingDraft.updateMany({
      where: { hotelId: params.hotelId, guestId: params.guestId, status: "OPEN" },
      data: { status: "CONFIRMED", bookingId }
    });
  });

  await refreshGuestSegmentTagsForGuest(params.guestId).catch((err) =>
    console.error("[guest-segmentation] refresh after confirm failed:", err instanceof Error ? err.message : String(err))
  );
  await mergeLightGuestMemoryFromConfirmedBooking({
    guestId: params.guestId,
    roomTypeId: offer.roomTypeId,
    roomTypeName: offer.roomTypeName,
    nights: offer.nights,
    totalAmount: offer.total,
    checkOut: params.checkOut
  }).catch((err) =>
    console.error("[light-guest-memory] merge after confirm failed:", err instanceof Error ? err.message : String(err))
  );
  await createRoleRoutedNotification({
    hotelId: params.hotelId,
    propertyId: offer.propertyId,
    roles: [UserRole.FRONTDESK, UserRole.MANAGER, UserRole.OWNER],
    title: "New booking confirmed",
    body: `Booking ${bookingId} is confirmed and requires operational follow-up.`,
    category: "bookings",
    severity: "high",
    link: `/admin/bookings/${encodeURIComponent(bookingId)}`,
    sourceType: "BOOKING_CONFIRMED",
    sourceId: bookingId,
    requiresAttention: true
  }).catch(() => undefined);

  await trackDecisionEventSafe({
    hotelId: params.hotelId,
    propertyId: offer.propertyId,
    eventType: "booking_completed",
    guestId: params.guestId,
    bookingId,
    conversationId: params.conversationId,
    source: "booking_service_confirm"
  });
  const confirmedCount = await prisma.booking.count({
    where: { hotelId: params.hotelId, guestId: params.guestId, status: BookingStatus.CONFIRMED }
  });
  if (confirmedCount >= 2) {
    await trackDecisionEventSafe({
      hotelId: params.hotelId,
      propertyId: offer.propertyId,
      eventType: "repeat_booking",
      guestId: params.guestId,
      bookingId,
      conversationId: params.conversationId,
      source: "booking_service_confirm",
      dedupeKey: `repeat_booking:${params.guestId}:${bookingId}`
    });
    await trackDecisionEventSafe({
      hotelId: params.hotelId,
      propertyId: offer.propertyId,
      eventType: "returning_guest",
      guestId: params.guestId,
      bookingId,
      conversationId: params.conversationId,
      source: "booking_service_confirm",
      dedupeKey: `returning_guest:${params.guestId}:${bookingId}`
    });
  }
  const followupSent = await prisma.guestFollowUp.findFirst({
    where: {
      hotelId: params.hotelId,
      guestId: params.guestId,
      status: "SENT",
      sentAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) }
    },
    orderBy: { sentAt: "desc" },
    select: { id: true }
  });
  if (followupSent) {
    await trackDecisionEventSafe({
      hotelId: params.hotelId,
      propertyId: offer.propertyId,
      eventType: "followup_converted",
      guestId: params.guestId,
      bookingId,
      conversationId: params.conversationId,
      source: "booking_after_followup",
      dedupeKey: `followup_converted:${followupSent.id}:${bookingId}`
    });
  }

  return {
    bookingId,
    roomTypeId: offer.roomTypeId,
    roomTypeName: offer.roomTypeName,
    propertyId: offer.propertyId,
    nights: offer.nights,
    totalAmount: offer.total
  };
}

/**
 * Physical unit overlap check (any room type). Excludes the given booking so moves stay idempotent.
 */
export async function assertRoomUnitAvailableForBookingStayTx(
  tx: Prisma.TransactionClient,
  params: {
    hotelId: string;
    roomUnitId: string;
    checkIn: Date;
    checkOut: Date;
    excludeBookingId: string;
  }
): Promise<void> {
  const unit = await tx.roomUnit.findFirst({
    where: { id: params.roomUnitId, hotelId: params.hotelId, isActive: true },
    select: { id: true, notes: true }
  });
  if (!unit) {
    throw new Error("Target room unit was not found or is inactive.");
  }
  if (isRoomUnitBlockedForGuestAssignment(unit.notes)) {
    throw new Error("Target room is blocked for housekeeping or maintenance.");
  }

  const overlap = await tx.booking.count({
    where: {
      hotelId: params.hotelId,
      roomUnitId: params.roomUnitId,
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      checkIn: { lt: params.checkOut },
      checkOut: { gt: params.checkIn },
      id: { not: params.excludeBookingId }
    }
  });
  if (overlap > 0) {
    throw new Error("Target room is already assigned for overlapping stay dates.");
  }
}

export type BookingRoomReassignmentResult = {
  fromRoomUnitId: string | null;
  toRoomUnitId: string;
  fromRoomUnitName: string | null;
  toRoomUnitName: string;
};

/**
 * Moves a booking to another physical unit (same room type). Updates MAIN folio unit, folio lines tied to the old unit,
 * and open housekeeping tasks for this booking on the old unit. Caller should log audit.
 */
export async function reassignBookingRoomUnitTx(
  tx: Prisma.TransactionClient,
  params: { hotelId: string; bookingId: string; targetRoomUnitId: string }
): Promise<BookingRoomReassignmentResult> {
  const booking = await tx.booking.findFirst({
    where: { id: params.bookingId, hotelId: params.hotelId },
    select: {
      id: true,
      roomTypeId: true,
      roomUnitId: true,
      checkIn: true,
      checkOut: true,
      status: true
    }
  });
  if (!booking) {
    throw new Error("Booking not found.");
  }
  if (booking.status !== BookingStatus.PENDING && booking.status !== BookingStatus.CONFIRMED) {
    throw new Error("Only pending or confirmed bookings can change room assignment.");
  }

  const target = await tx.roomUnit.findFirst({
    where: { id: params.targetRoomUnitId, hotelId: params.hotelId, isActive: true },
    select: { id: true, name: true, roomTypeId: true, notes: true }
  });
  if (!target) {
    throw new Error("Target room unit was not found or is inactive.");
  }
  if (target.roomTypeId !== booking.roomTypeId) {
    throw new Error(
      "Room change requires the same room category as the booking. Adjust room type separately if an upgrade/downgrade is needed."
    );
  }

  await assertRoomUnitAvailableForBookingStayTx(tx, {
    hotelId: params.hotelId,
    roomUnitId: target.id,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    excludeBookingId: booking.id
  });

  const fromId = booking.roomUnitId;
  if (fromId === target.id) {
    return {
      fromRoomUnitId: fromId,
      toRoomUnitId: target.id,
      fromRoomUnitName: target.name,
      toRoomUnitName: target.name
    };
  }

  let fromName: string | null = null;
  if (fromId) {
    const fromUnit = await tx.roomUnit.findUnique({ where: { id: fromId }, select: { name: true } });
    fromName = fromUnit?.name ?? null;
  }

  await tx.booking.update({
    where: { id: booking.id },
    data: { roomUnitId: target.id }
  });

  await tx.folio.updateMany({
    where: { hotelId: params.hotelId, bookingId: booking.id, folioCode: "MAIN" },
    data: { roomUnitId: target.id }
  });

  if (fromId) {
    await tx.folioTransaction.updateMany({
      where: { hotelId: params.hotelId, bookingId: booking.id, roomUnitId: fromId },
      data: { roomUnitId: target.id }
    });
    await tx.housekeepingTask.updateMany({
      where: {
        hotelId: params.hotelId,
        bookingId: booking.id,
        roomUnitId: fromId,
        status: { in: [HousekeepingTaskStatus.PENDING, HousekeepingTaskStatus.IN_PROGRESS] }
      },
      data: { roomUnitId: target.id }
    });
  }

  return {
    fromRoomUnitId: fromId,
    toRoomUnitId: target.id,
    fromRoomUnitName: fromName,
    toRoomUnitName: target.name
  };
}

