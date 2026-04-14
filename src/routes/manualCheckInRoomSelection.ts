import type { RoomType, RoomUnit } from "@prisma/client";
import { BookingStatus } from "@prisma/client";
import { inventoryDayRangeExclusive } from "../core/inventoryDate";
import { manualCheckInFitsRoomType } from "../core/roomOccupancy";
import { prisma } from "../db";

export type RoomTypeWithUnits = RoomType & { roomUnits: RoomUnit[] };

type OpsRoomStatus = "AVAILABLE" | "RESERVED" | "OCCUPIED" | "CLEANING" | "MAINTENANCE";

function parseOpsRoomStatusFromNotes(notes: string | null | undefined): OpsRoomStatus | null {
  if (!notes) return null;
  const m = notes.match(/@manual-status:(AVAILABLE|RESERVED|OCCUPIED|CLEANING|MAINTENANCE)@/i);
  return (m?.[1]?.toUpperCase() as OpsRoomStatus | undefined) ?? null;
}

function startOfDayLocal(input: Date): Date {
  const d = new Date(input);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDaysLocal(input: Date, days: number): Date {
  const d = new Date(input);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Same rule as assertInventoryCanReserveTx in admin (rooms=1), without a transaction client.
 */
async function inventoryAllowsOneMoreBooking(params: {
  hotelId: string;
  roomTypeId: string;
  checkIn: Date;
  checkOut: Date;
}): Promise<boolean> {
  const { hotelId, roomTypeId, checkIn, checkOut } = params;
  const roomType = await prisma.roomType.findFirst({
    where: { id: roomTypeId, hotelId },
    select: { totalInventory: true }
  });
  const defaultTotal = roomType?.totalInventory ?? 1;
  let date = startOfDayLocal(checkIn);
  const end = startOfDayLocal(checkOut);
  while (date.getTime() < end.getTime()) {
    const dr = inventoryDayRangeExclusive(date);
    const row = await prisma.inventory.findFirst({
      where: { hotelId, roomTypeId, date: { gte: dr.gte, lt: dr.lt } },
      select: { total: true, reserved: true, closedOut: true }
    });
    if (row?.closedOut) return false;
    const total = row?.total ?? defaultTotal;
    const reserved = row?.reserved ?? 0;
    if (reserved + 1 > total) return false;
    date = addDaysLocal(date, 1);
  }
  return true;
}

async function unitHasOverlappingBooking(params: {
  hotelId: string;
  roomUnitId: string;
  checkIn: Date;
  checkOut: Date;
}): Promise<boolean> {
  const n = await prisma.booking.count({
    where: {
      hotelId: params.hotelId,
      roomUnitId: params.roomUnitId,
      status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      checkIn: { lt: params.checkOut },
      checkOut: { gt: params.checkIn }
    }
  });
  return n > 0;
}

export type ManualCheckInRoomSelectionSnapshot = {
  selectableRoomTypes: Array<{
    id: string;
    name: string;
    code: string;
    capacity: number;
    baseNightlyRate: number;
  }>;
  /** Available units per room type (only types with ≥1 free unit appear in selectableRoomTypes). */
  availableUnitsByRoomTypeId: Record<string, Array<{ id: string; name: string }>>;
};

/**
 * Room types that fit guest mix + inventory + at least one physical unit free for the stay dates.
 */
export async function computeManualCheckInRoomSelection(params: {
  hotelId: string;
  checkIn: Date;
  checkOut: Date;
  adults: number;
  children: number;
  roomTypes: RoomTypeWithUnits[];
}): Promise<ManualCheckInRoomSelectionSnapshot> {
  const { hotelId, checkIn, checkOut, adults, children, roomTypes } = params;
  const cin = startOfDayLocal(checkIn);
  const cout = startOfDayLocal(checkOut);
  const selectableRoomTypes: ManualCheckInRoomSelectionSnapshot["selectableRoomTypes"] = [];
  const availableUnitsByRoomTypeId: Record<string, Array<{ id: string; name: string }>> = {};

  if (cout.getTime() <= cin.getTime()) {
    return { selectableRoomTypes, availableUnitsByRoomTypeId };
  }

  for (const rt of roomTypes) {
    const fit = manualCheckInFitsRoomType(rt, adults, children);
    if (!fit.ok) continue;

    const invOk = await inventoryAllowsOneMoreBooking({
      hotelId,
      roomTypeId: rt.id,
      checkIn: cin,
      checkOut: cout
    });
    if (!invOk) continue;

    const freeUnits: Array<{ id: string; name: string }> = [];
    for (const u of rt.roomUnits) {
      if (!u.isActive) continue;
      const ops = parseOpsRoomStatusFromNotes(u.notes);
      if (ops === "CLEANING" || ops === "MAINTENANCE") continue;
      const busy = await unitHasOverlappingBooking({
        hotelId,
        roomUnitId: u.id,
        checkIn: cin,
        checkOut: cout
      });
      if (!busy) freeUnits.push({ id: u.id, name: u.name });
    }

    if (freeUnits.length === 0) continue;

    selectableRoomTypes.push({
      id: rt.id,
      name: rt.name,
      code: rt.code,
      capacity: rt.capacity,
      baseNightlyRate: rt.baseNightlyRate
    });
    availableUnitsByRoomTypeId[rt.id] = freeUnits;
  }

  return { selectableRoomTypes, availableUnitsByRoomTypeId };
}
