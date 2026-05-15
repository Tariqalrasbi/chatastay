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
import { addDays, findAvailableRoomType, findAvailableRoomTypes, startOfDay } from "./availability";
import { findRoomOfferForRoomType } from "./roomStayAllocation";
import { inventoryDayRangeExclusive } from "./inventoryDate";
import { trackDecisionEventSafe } from "./decisionAnalytics";
import { computeMealPlanSurchargeForStay, type MealPlanCode } from "./frontDeskPricing";

type OpsRoomStatus = "AVAILABLE" | "RESERVED" | "OCCUPIED" | "CLEANING" | "MAINTENANCE";

type RoomUnitAdjRow = {
  id: string;
  notes: string | null;
  name: string;
  sortOrder: number | null;
  floor: string | null;
  building: string | null;
};

const RE_NAME_CHUNK = /(\d+|\D+)/g;

function nameSortKey(name: string): Array<string | number> {
  const parts = name.match(RE_NAME_CHUNK);
  if (!parts) return [name];
  return parts.map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p.toLowerCase()));
}

function compareNaturalName(a: string, b: string): number {
  const ka = nameSortKey(a);
  const kb = nameSortKey(b);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i += 1) {
    const va = ka[i];
    const vb = kb[i];
    if (va === undefined) return -1;
    if (vb === undefined) return 1;
    if (typeof va === "number" && typeof vb === "number") {
      if (va !== vb) return va - vb;
    } else if (typeof va === "string" && typeof vb === "string") {
      const c = va.localeCompare(vb);
      if (c !== 0) return c;
    } else {
      return typeof va === "number" ? -1 : 1;
    }
  }
  return 0;
}

function sortRoomUnitsForAdjacency(units: RoomUnitAdjRow[]): RoomUnitAdjRow[] {
  return [...units].sort((a, b) => {
    const ba = (a.building ?? "").localeCompare(b.building ?? "");
    if (ba !== 0) return ba;
    const fa = compareNaturalName(a.floor ?? "", b.floor ?? "");
    if (fa !== 0) return fa;
    const sa = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    if (sa !== 0) return sa;
    return compareNaturalName(a.name, b.name);
  });
}

/**
 * Picks `count` physical units for the same room type, preferring consecutive units
 * in building / floor / sort / natural room-name order. Falls back to nearest indices.
 */
export async function pickAdjacentAvailableRoomUnitIdsTx(params: {
  tx: Prisma.TransactionClient;
  hotelId: string;
  roomTypeId: string;
  checkIn: Date;
  checkOut: Date;
  count: number;
  excludeBookingId?: string;
}): Promise<string[]> {
  const n = Math.max(1, Math.floor(params.count));
  const rawUnits = await params.tx.roomUnit.findMany({
    where: { hotelId: params.hotelId, roomTypeId: params.roomTypeId, isActive: true },
    select: { id: true, notes: true, name: true, sortOrder: true, floor: true, building: true }
  });
  const units = sortRoomUnitsForAdjacency(rawUnits);
  if (!units.length || n > units.length) return [];

  const overlaps = await params.tx.booking.findMany({
    where: {
      hotelId: params.hotelId,
      roomTypeId: params.roomTypeId,
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] },
      checkIn: { lt: params.checkOut },
      checkOut: { gt: params.checkIn },
      roomUnitId: { not: null },
      ...(params.excludeBookingId ? { id: { not: params.excludeBookingId } } : {})
    },
    select: { roomUnitId: true }
  });
  const occupied = new Set(overlaps.map((row) => row.roomUnitId).filter((id): id is string => Boolean(id)));

  const availableMask = units.map(
    (u) => !occupied.has(u.id) && !isRoomUnitBlockedForGuestAssignment(u.notes)
  );

  for (let i = 0; i <= units.length - n; i += 1) {
    let ok = true;
    for (let j = 0; j < n; j += 1) {
      if (!availableMask[i + j]!) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return units.slice(i, i + n).map((u) => u.id);
    }
  }

  const picked: string[] = [];
  const used = new Set<string>();
  const availIndices = units
    .map((u, idx) => ({ u, idx }))
    .filter(({ u }) => !occupied.has(u.id) && !isRoomUnitBlockedForGuestAssignment(u.notes));
  if (availIndices.length < n) return [];

  picked.push(availIndices[0]!.u.id);
  used.add(availIndices[0]!.u.id);
  let lastIdx = availIndices[0]!.idx;
  for (let k = 1; k < n; k += 1) {
    let bestIdx: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const { u, idx } of availIndices) {
      if (used.has(u.id)) continue;
      const d = Math.abs(idx - lastIdx);
      if (d < bestDist || (d === bestDist && bestIdx !== null && idx < bestIdx)) {
        bestDist = d;
        bestIdx = idx;
      }
    }
    if (bestIdx === null) break;
    const chosen = units[bestIdx]!;
    picked.push(chosen.id);
    used.add(chosen.id);
    lastIdx = bestIdx;
  }
  return picked.length === n ? picked : [];
}

export type ConfirmedRoomStayLine = {
  roomTypeId: string;
  adults: number;
  children: number;
};

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
  const ids = await pickAdjacentAvailableRoomUnitIdsTx({
    tx: params.tx,
    hotelId: params.hotelId,
    roomTypeId: params.roomTypeId,
    checkIn: params.checkIn,
    checkOut: params.checkOut,
    count: 1,
    excludeBookingId: params.excludeBookingId
  });
  return ids[0] ?? null;
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

async function assertPhysicalInventoryRoomsTx(
  tx: Prisma.TransactionClient,
  hotelId: string,
  roomTypeId: string,
  checkIn: Date,
  checkOut: Date,
  roomsNeeded: number
): Promise<void> {
  const roomType = await tx.roomType.findFirst({
    where: { id: roomTypeId, hotelId, isActive: true }
  });
  if (!roomType) {
    throw new Error("Selected room type is no longer available.");
  }

  const overlappingCount = await tx.booking.count({
    where: {
      hotelId,
      roomTypeId,
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] },
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn }
    }
  });

  const stayStart = startOfDay(checkIn);
  const stayEnd = startOfDay(checkOut);
  const inventoryRows = await tx.inventory.findMany({
    where: { hotelId, roomTypeId, date: { gte: stayStart, lt: stayEnd } },
    select: { total: true, reserved: true, closedOut: true }
  });
  const blockedUnits = await tx.roomUnit.count({
    where: {
      hotelId,
      roomTypeId,
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

  if (availableRooms < roomsNeeded) {
    throw new Error("Availability changed while confirming booking.");
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
  /** Optional guest-selected room type from the mobile booking form. Falls back to best available. */
  preferredRoomTypeId?: string;
  /** When set with length >= 1, creates one booking per entry (mixed room types / per-room pax). Overrides single-offer path. */
  roomStays?: ConfirmedRoomStayLine[];
  mealPlan?: MealPlanCode;
  /** Distinguishes WhatsApp automation from front-desk / OTA sources. */
  source?: ChannelProvider;
}): Promise<{
  bookingId: string;
  bookingIds: string[];
  bookingGroupId?: string | null;
  roomTypeId: string;
  roomTypeName: string;
  propertyId: string;
  nights: number;
  totalAmount: number;
  roomCount: number;
  mealPlan: MealPlanCode;
  mealSubtotal: number;
}> {
  const existingBooking = await prisma.booking.findFirst({
    where: {
      hotelId: params.hotelId,
      guestId: params.guestId,
      conversationId: params.conversationId,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] }
    },
    include: { roomType: true }
  });
  if (existingBooking) {
    return {
      bookingId: existingBooking.id,
      roomTypeId: existingBooking.roomTypeId,
      roomTypeName: existingBooking.roomType.name,
      propertyId: existingBooking.propertyId,
      nights: existingBooking.nights,
      totalAmount: existingBooking.totalAmount,
      bookingIds: [existingBooking.id],
      bookingGroupId: existingBooking.bookingGroupId,
      roomCount: params.rooms,
      mealPlan: (existingBooking.mealPlan as MealPlanCode | null) ?? "NONE",
      mealSubtotal: 0
    };
  }

  const mealPlan: MealPlanCode = params.mealPlan ?? "NONE";

  type HeteroPlanLine = {
    offer: import("./availability").RoomOffer;
    adults: number;
    children: number;
    mealPart: number;
    lineTotal: number;
  };
  let heteroLines: HeteroPlanLine[] | null = null;
  let offer: import("./availability").RoomOffer;
  let adults: number;
  let children: number;
  let mealSubtotal: number;
  let totalWithMeals: number;
  let perRoomTotal: number;

  if (params.roomStays && params.roomStays.length > 0) {
    if (params.roomStays.length !== params.rooms) {
      throw new Error("Room allocation must match the number of rooms.");
    }
    const sumPax = params.roomStays.reduce((s, r) => s + r.adults + r.children, 0);
    if (sumPax !== params.guests) {
      throw new Error("Per-room guests must add up to the total party size.");
    }
    const lines: HeteroPlanLine[] = [];
    let ms = 0;
    let rt = 0;
    for (const stay of params.roomStays) {
      const o = await findRoomOfferForRoomType({
        hotelId: params.hotelId,
        checkIn: params.checkIn,
        checkOut: params.checkOut,
        roomTypeId: stay.roomTypeId,
        adults: stay.adults,
        children: stay.children
      });
      if (!o) {
        throw new Error("No availability for selected dates.");
      }
      const mp = computeMealPlanSurchargeForStay({
        mealPlan,
        adults: stay.adults,
        children: stay.children,
        nights: o.nights,
        rooms: 1
      });
      ms += mp;
      rt += o.total;
      lines.push({
        offer: o,
        adults: stay.adults,
        children: stay.children,
        mealPart: mp,
        lineTotal: Number((o.total + mp).toFixed(2))
      });
    }
    heteroLines = lines;
    offer = lines[0]!.offer;
    adults = lines.reduce((s, l) => s + l.adults, 0);
    children = lines.reduce((s, l) => s + l.children, 0);
    mealSubtotal = Number(ms.toFixed(2));
    totalWithMeals = Number((rt + ms).toFixed(2));
    perRoomTotal = 0;
  } else {
    const singleOffer = params.preferredRoomTypeId
      ? (await findAvailableRoomTypes({
          hotelId: params.hotelId,
          checkIn: params.checkIn,
          checkOut: params.checkOut,
          guests: params.guests,
          rooms: params.rooms,
          adults: params.adults,
          children: params.children
        })).find((item) => item.roomTypeId === params.preferredRoomTypeId) ?? null
      : await findAvailableRoomType({
          hotelId: params.hotelId,
          checkIn: params.checkIn,
          checkOut: params.checkOut,
          guests: params.guests,
          rooms: params.rooms,
          adults: params.adults,
          children: params.children
        });
    if (!singleOffer) {
      throw new Error("No availability for selected dates.");
    }
    offer = singleOffer;
    adults = params.adults ?? params.guests;
    children = params.children ?? 0;
    const ms = computeMealPlanSurchargeForStay({
      mealPlan,
      adults,
      children,
      nights: offer.nights,
      rooms: params.rooms
    });
    mealSubtotal = ms;
    totalWithMeals = Number((offer.total + mealSubtotal).toFixed(2));
    perRoomTotal = Number((totalWithMeals / Math.max(1, params.rooms)).toFixed(2));
  }

  const compositeRoomTypeName =
    heteroLines && heteroLines.length > 0
      ? heteroLines.map((l) => l.offer.roomTypeName).join(" + ")
      : offer.roomTypeName;

  const bookingId = `WB-${Date.now().toString(36).toUpperCase()}`;
  const bookingIds: string[] = [bookingId];
  let bookingGroupId: string | null = null;
  await prisma.$transaction(async (tx) => {
    const src = params.source ?? ChannelProvider.WHATSAPP;

    if (heteroLines && heteroLines.length > 0) {
      const lines = heteroLines;
      const typeCounts = new Map<string, number>();
      for (const ln of lines) {
        typeCounts.set(ln.offer.roomTypeId, (typeCounts.get(ln.offer.roomTypeId) ?? 0) + 1);
      }
      for (const [rtId, cnt] of typeCounts.entries()) {
        await assertPhysicalInventoryRoomsTx(tx, params.hotelId, rtId, params.checkIn, params.checkOut, cnt);
      }

      const byType = new Map<string, number[]>();
      lines.forEach((ln, idx) => {
        const arr = byType.get(ln.offer.roomTypeId) ?? [];
        arr.push(idx);
        byType.set(ln.offer.roomTypeId, arr);
      });
      const unitByLineIdx: (string | null)[] = new Array(lines.length).fill(null);
      for (const [rtId, indices] of byType.entries()) {
        const picked = await pickAdjacentAvailableRoomUnitIdsTx({
          tx,
          hotelId: params.hotelId,
          roomTypeId: rtId,
          checkIn: params.checkIn,
          checkOut: params.checkOut,
          count: indices.length
        });
        if (picked.length !== indices.length) {
          throw new Error("Could not assign physical rooms for these dates.");
        }
        indices.forEach((lineIdx, j) => {
          unitByLineIdx[lineIdx] = picked[j] ?? null;
        });
      }

      const group =
        lines.length > 1
          ? await tx.bookingGroup.create({
              data: { hotelId: params.hotelId, label: bookingId }
            })
          : null;
      bookingGroupId = group?.id ?? null;
      bookingIds.length = 0;

      for (let i = 0; i < lines.length; i += 1) {
        const ln = lines[i]!;
        const id = i === 0 ? bookingId : `WB-${Date.now().toString(36).toUpperCase()}-${i + 1}`;
        bookingIds.push(id);
        const referenceCode = await allocateBookingReferenceCode(tx, {
          hotelId: params.hotelId,
          source: src,
          refDate: new Date()
        });
        await tx.booking.create({
          data: {
            id,
            hotelId: params.hotelId,
            propertyId: ln.offer.propertyId,
            roomTypeId: ln.offer.roomTypeId,
            roomUnitId: unitByLineIdx[i],
            guestId: params.guestId,
            conversationId: params.conversationId,
            checkIn: params.checkIn,
            checkOut: params.checkOut,
            nights: ln.offer.nights,
            adults: ln.adults,
            children: ln.children,
            totalAmount: ln.lineTotal,
            currency: params.currency,
            status: BookingStatus.CONFIRMED,
            paymentStatus: PaymentStatus.PENDING,
            source: src,
            referenceCode,
            mealPlan,
            bookingGroupId: bookingGroupId,
            isPrimaryPayer: lines.length > 1 && i === 0
          }
        });
        await recordBookingStatusChange(tx, {
          hotelId: params.hotelId,
          bookingId: id,
          fromStatus: null,
          toStatus: BookingStatus.CONFIRMED,
          source: String(params.source ?? ChannelProvider.DIRECT)
        });
        await ensureActiveFolio(tx, {
          hotelId: params.hotelId,
          bookingId: id,
          guestId: params.guestId,
          roomUnitId: unitByLineIdx[i],
          currency: params.currency,
          staffId: null
        });
      }

      for (const ln of lines) {
        await reserveInventoryForBooking({
          tx,
          hotelId: params.hotelId,
          roomTypeId: ln.offer.roomTypeId,
          propertyId: ln.offer.propertyId,
          checkIn: params.checkIn,
          checkOut: params.checkOut,
          rooms: 1
        });
      }
    } else {
      await assertPhysicalInventoryRoomsTx(
        tx,
        params.hotelId,
        offer.roomTypeId,
        params.checkIn,
        params.checkOut,
        params.rooms
      );

      const unitIds = await pickAdjacentAvailableRoomUnitIdsTx({
        tx,
        hotelId: params.hotelId,
        roomTypeId: offer.roomTypeId,
        checkIn: params.checkIn,
        checkOut: params.checkOut,
        count: params.rooms
      });
      if (unitIds.length !== params.rooms) {
        throw new Error("Could not assign rooms for these dates.");
      }
      const roomUnitId = unitIds[0] ?? null;

      const referenceCode = await allocateBookingReferenceCode(tx, {
        hotelId: params.hotelId,
        source: src,
        refDate: new Date()
      });

      if (params.rooms > 1) {
        const group = await tx.bookingGroup.create({
          data: { hotelId: params.hotelId, label: bookingId }
        });
        bookingGroupId = group.id;
      }

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
          totalAmount: params.rooms > 1 ? perRoomTotal : totalWithMeals,
          currency: params.currency,
          status: BookingStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PENDING,
          source: src,
          referenceCode,
          mealPlan,
          bookingGroupId,
          isPrimaryPayer: params.rooms > 1
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

      for (let roomIndex = 2; roomIndex <= params.rooms; roomIndex += 1) {
        const extraBookingId = `WB-${Date.now().toString(36).toUpperCase()}-${roomIndex}`;
        bookingIds.push(extraBookingId);
        const extraReferenceCode = await allocateBookingReferenceCode(tx, {
          hotelId: params.hotelId,
          source: src,
          refDate: new Date()
        });
        const extraRoomUnitId = unitIds[roomIndex - 1] ?? null;
        await tx.booking.create({
          data: {
            id: extraBookingId,
            hotelId: params.hotelId,
            propertyId: offer.propertyId,
            roomTypeId: offer.roomTypeId,
            roomUnitId: extraRoomUnitId,
            guestId: params.guestId,
            conversationId: params.conversationId,
            checkIn: params.checkIn,
            checkOut: params.checkOut,
            nights: offer.nights,
            adults: 0,
            children: 0,
            totalAmount: perRoomTotal,
            currency: params.currency,
            status: BookingStatus.CONFIRMED,
            paymentStatus: PaymentStatus.PENDING,
            source: src,
            referenceCode: extraReferenceCode,
            mealPlan,
            bookingGroupId,
            isPrimaryPayer: false
          }
        });
        await recordBookingStatusChange(tx, {
          hotelId: params.hotelId,
          bookingId: extraBookingId,
          fromStatus: null,
          toStatus: BookingStatus.CONFIRMED,
          source: String(params.source ?? ChannelProvider.DIRECT)
        });
        await ensureActiveFolio(tx, {
          hotelId: params.hotelId,
          bookingId: extraBookingId,
          guestId: params.guestId,
          roomUnitId: extraRoomUnitId,
          currency: params.currency,
          staffId: null
        });
      }

      await reserveInventoryForBooking({
        tx,
        hotelId: params.hotelId,
        roomTypeId: offer.roomTypeId,
        propertyId: offer.propertyId,
        checkIn: params.checkIn,
        checkOut: params.checkOut,
        rooms: params.rooms
      });
    }

    await tx.conversation.update({
      where: { id: params.conversationId },
      data: { state: ConversationState.CONFIRMED, lastMessageAt: new Date(), propertyId: offer.propertyId }
    });

    await tx.bookingDraft.updateMany({
      where: { hotelId: params.hotelId, guestId: params.guestId, status: "OPEN" },
      data: { status: "CONFIRMED", bookingId }
    });

    /// Phase E: marketplace commission ledger.
    /// Auto-create one Commission row per CHATASTAY_MARKETPLACE booking using the
    /// hotel's current plan as the percent source. Snapshotted at booking time so
    /// later plan edits cannot rewrite history. Stays inside the same transaction
    /// so the ledger and bookings are guaranteed consistent.
    if (src === ChannelProvider.CHATASTAY_MARKETPLACE) {
      const subscription = await tx.subscription.findFirst({
        where: { hotelId: params.hotelId },
        include: { plan: true },
        orderBy: { createdAt: "desc" }
      });
      const plan = subscription?.plan ?? null;
      const percentBps = plan?.commissionBps ?? 0;
      if (percentBps > 0) {
        const commissionAmount = Number(((totalWithMeals * percentBps) / 10000).toFixed(2));
        await tx.commission.create({
          data: {
            hotelId: params.hotelId,
            bookingId,
            planId: plan?.id ?? null,
            planCodeSnapshot: plan?.code ?? null,
            percentBps,
            amountCalc: commissionAmount,
            currency: params.currency,
            status: "PENDING"
          }
        });
      }
    }
  });

  await refreshGuestSegmentTagsForGuest(params.guestId).catch((err) =>
    console.error("[guest-segmentation] refresh after confirm failed:", err instanceof Error ? err.message : String(err))
  );
  await mergeLightGuestMemoryFromConfirmedBooking({
    guestId: params.guestId,
    roomTypeId: offer.roomTypeId,
    roomTypeName: compositeRoomTypeName,
    nights: offer.nights,
    totalAmount: totalWithMeals,
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
    requiresAttention: true,
    audience: ["front_desk", "owner"]
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
    bookingIds,
    bookingGroupId,
    roomTypeId: offer.roomTypeId,
    roomTypeName: compositeRoomTypeName,
    propertyId: offer.propertyId,
    nights: offer.nights,
    totalAmount: totalWithMeals,
    roomCount: params.rooms,
    mealPlan,
    mealSubtotal
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
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] },
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
  if (
    booking.status !== BookingStatus.PENDING &&
    booking.status !== BookingStatus.CONFIRMED &&
    booking.status !== BookingStatus.CHECKED_IN
  ) {
    throw new Error("Only pending, confirmed, or checked-in bookings can change room assignment.");
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

