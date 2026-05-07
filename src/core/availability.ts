import { BookingStatus, PropertyStatus } from "@prisma/client";
import { prisma } from "../db";
import { inventoryDayRangeExclusive } from "./inventoryDate";
import { roomTypeAllowsOccupancy } from "./roomOccupancy";

export type RoomOffer = {
  roomTypeId: string;
  roomTypeName: string;
  propertyId: string;
  nightlyTotal: number;
  total: number;
  nights: number;
};

export type DayAvailability = {
  date: string;
  available: boolean;
  minAvailableRooms: number;
  cheapestRate?: number;
  reason?: "CLOSED_OUT" | "NO_ROOMS" | "NO_CAPACITY" | "NO_ACTIVE_ROOMTYPE";
};

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export async function findAvailableRoomType(params: {
  hotelId: string;
  checkIn: Date;
  checkOut: Date;
  guests: number;
  rooms: number;
  /** When set with children, filters by room-type adult/child rules (not only total capacity). */
  adults?: number;
  children?: number;
}): Promise<RoomOffer | null> {
  const nights = Math.ceil((params.checkOut.getTime() - params.checkIn.getTime()) / (1000 * 60 * 60 * 24));
  if (nights <= 0) return null;

  const capacityPerRoom = Math.ceil(params.guests / Math.max(1, params.rooms));
  // SaaS lifecycle: never quote / book on a non-ACTIVE property. RoomType.isActive is property-staff configurable;
  // Property.status is platform-controlled (DRAFT during onboarding, SUSPENDED for billing/owner action, ARCHIVED on close)
  // so both gates must pass for a room type to be eligible.
  const roomTypes = await prisma.roomType.findMany({
    where: {
      hotelId: params.hotelId,
      isActive: true,
      capacity: { gte: capacityPerRoom },
      property: { status: PropertyStatus.ACTIVE }
    },
    orderBy: { baseNightlyRate: "asc" }
  });

  const useMix = params.rooms <= 1 && params.adults !== undefined && params.children !== undefined;
  const filtered = useMix
    ? roomTypes.filter((rt) => roomTypeAllowsOccupancy(rt.code, params.adults!, params.children!).ok)
    : roomTypes;

  const stayStart = startOfDay(params.checkIn);
  const stayEnd = startOfDay(params.checkOut);
  for (const roomType of filtered) {
    const inventoryRows = await prisma.inventory.findMany({
      where: { hotelId: params.hotelId, roomTypeId: roomType.id, date: { gte: stayStart, lt: stayEnd } },
      select: { total: true, reserved: true, closedOut: true }
    });

    let availableRooms: number;
    if (!inventoryRows.length) {
      const overlapping = await prisma.booking.count({
        where: {
          hotelId: params.hotelId,
          roomTypeId: roomType.id,
          status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] },
          checkIn: { lt: params.checkOut },
          checkOut: { gt: params.checkIn }
        }
      });
      availableRooms = Math.max(0, roomType.totalInventory - overlapping);
    } else if (inventoryRows.some((row) => row.closedOut)) {
      availableRooms = 0;
    } else {
      availableRooms = inventoryRows.reduce((min, row) => Math.min(min, Math.max(0, row.total - row.reserved)), Number.POSITIVE_INFINITY);
    }

    if (availableRooms >= params.rooms) {
      const nightlyTotal = Number((roomType.baseNightlyRate * params.rooms).toFixed(2));
      const total = Number((nightlyTotal * nights).toFixed(2));
      return {
        roomTypeId: roomType.id,
        roomTypeName: roomType.name,
        propertyId: roomType.propertyId,
        nightlyTotal,
        total,
        nights
      };
    }
  }
  return null;
}

/** Returns all room types that have availability for the given dates/guests/rooms, ordered by price. */
export async function findAvailableRoomTypes(params: {
  hotelId: string;
  checkIn: Date;
  checkOut: Date;
  guests: number;
  rooms: number;
  adults?: number;
  children?: number;
}): Promise<RoomOffer[]> {
  const nights = Math.ceil((params.checkOut.getTime() - params.checkIn.getTime()) / (1000 * 60 * 60 * 24));
  if (nights <= 0) return [];

  const capacityPerRoom = Math.ceil(params.guests / Math.max(1, params.rooms));
  // Mirror of findAvailableRoomType(): exclude room types whose Property is non-ACTIVE.
  const roomTypes = await prisma.roomType.findMany({
    where: {
      hotelId: params.hotelId,
      isActive: true,
      capacity: { gte: capacityPerRoom },
      property: { status: PropertyStatus.ACTIVE }
    },
    orderBy: { baseNightlyRate: "asc" }
  });

  const useMix = params.rooms <= 1 && params.adults !== undefined && params.children !== undefined;
  const filtered = useMix
    ? roomTypes.filter((rt) => roomTypeAllowsOccupancy(rt.code, params.adults!, params.children!).ok)
    : roomTypes;

  const stayStart = startOfDay(params.checkIn);
  const stayEnd = startOfDay(params.checkOut);
  const offers: RoomOffer[] = [];
  for (const roomType of filtered) {
    const inventoryRows = await prisma.inventory.findMany({
      where: { hotelId: params.hotelId, roomTypeId: roomType.id, date: { gte: stayStart, lt: stayEnd } },
      select: { total: true, reserved: true, closedOut: true }
    });

    let availableRooms: number;
    if (!inventoryRows.length) {
      const overlapping = await prisma.booking.count({
        where: {
          hotelId: params.hotelId,
          roomTypeId: roomType.id,
          status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] },
          checkIn: { lt: params.checkOut },
          checkOut: { gt: params.checkIn }
        }
      });
      availableRooms = Math.max(0, roomType.totalInventory - overlapping);
    } else if (inventoryRows.some((row) => row.closedOut)) {
      availableRooms = 0;
    } else {
      availableRooms = inventoryRows.reduce((min, row) => Math.min(min, Math.max(0, row.total - row.reserved)), Number.POSITIVE_INFINITY);
    }

    if (availableRooms >= params.rooms) {
      const nightlyTotal = Number((roomType.baseNightlyRate * params.rooms).toFixed(2));
      const total = Number((nightlyTotal * nights).toFixed(2));
      offers.push({
        roomTypeId: roomType.id,
        roomTypeName: roomType.name,
        propertyId: roomType.propertyId,
        nightlyTotal,
        total,
        nights
      });
    }
  }
  return offers;
}

export async function getAvailableCheckInDates(params: {
  hotelId: string;
  fromDate: Date;
  days: number;
  guests: number;
  rooms: number;
}): Promise<string[]> {
  const start = startOfDay(params.fromDate);
  const available: string[] = [];
  for (let offset = 0; offset < params.days; offset += 1) {
    const checkIn = addDays(start, offset);
    const checkOut = addDays(checkIn, 1);
    const offer = await findAvailableRoomType({
      hotelId: params.hotelId,
      checkIn,
      checkOut,
      guests: params.guests,
      rooms: params.rooms
    });
    if (offer) available.push(toIsoDate(checkIn));
  }
  return available;
}

export async function getAvailableCheckOutDates(params: {
  hotelId: string;
  checkIn: Date;
  maxNights: number;
  guests: number;
  rooms: number;
}): Promise<string[]> {
  const options: string[] = [];
  const checkIn = startOfDay(params.checkIn);
  for (let nights = 1; nights <= params.maxNights; nights += 1) {
    const checkOut = addDays(checkIn, nights);
    const offer = await findAvailableRoomType({
      hotelId: params.hotelId,
      checkIn,
      checkOut,
      guests: params.guests,
      rooms: params.rooms
    });
    if (offer) options.push(toIsoDate(checkOut));
  }
  return options;
}

export async function getDayAvailability(params: {
  hotelId: string;
  date: Date;
  guests: number;
  rooms: number;
}): Promise<DayAvailability> {
  const checkIn = startOfDay(params.date);
  const checkOut = addDays(checkIn, 1);
  const capacityPerRoom = Math.ceil(params.guests / Math.max(1, params.rooms));
  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId: params.hotelId, isActive: true, capacity: { gte: capacityPerRoom } },
    orderBy: { baseNightlyRate: "asc" }
  });
  if (!roomTypes.length) {
    return {
      date: toIsoDate(checkIn),
      available: false,
      minAvailableRooms: 0,
      reason: "NO_ACTIVE_ROOMTYPE"
    };
  }

  let minAvailableRoomsAcrossTypes = 0;
  let cheapestRate: number | undefined;
  let sawClosedOut = false;
  const dayRange = inventoryDayRangeExclusive(checkIn);
  for (const roomType of roomTypes) {
    const inventory = await prisma.inventory.findFirst({
      where: { hotelId: params.hotelId, roomTypeId: roomType.id, date: { gte: dayRange.gte, lt: dayRange.lt } },
      select: { total: true, reserved: true, closedOut: true }
    });
    if (inventory?.closedOut) {
      sawClosedOut = true;
      continue;
    }
    const overlapping = await prisma.booking.count({
      where: {
        hotelId: params.hotelId,
        roomTypeId: roomType.id,
        status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.CHECKED_IN] },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn }
      }
    });
    const total = inventory?.total ?? roomType.totalInventory;
    const reserved = inventory?.reserved ?? 0;
    const available = Math.max(0, total - Math.max(reserved, overlapping));
    minAvailableRoomsAcrossTypes = Math.max(minAvailableRoomsAcrossTypes, available);
    if (available >= params.rooms) {
      const nightly = Number((roomType.baseNightlyRate * params.rooms).toFixed(2));
      cheapestRate = cheapestRate === undefined ? nightly : Math.min(cheapestRate, nightly);
    }
  }

  if (cheapestRate !== undefined) {
    return {
      date: toIsoDate(checkIn),
      available: true,
      minAvailableRooms: minAvailableRoomsAcrossTypes,
      cheapestRate
    };
  }

  return {
    date: toIsoDate(checkIn),
    available: false,
    minAvailableRooms: 0,
    reason: sawClosedOut ? "CLOSED_OUT" : "NO_ROOMS"
  };
}

import { daysBetween } from "./util";

export interface AvailabilityInput {
  checkIn: Date;
  checkOut: Date;
  totalInventory: number;
  alreadyBooked: number;
}

export function hasAvailability(input: AvailabilityInput): boolean {
  const nights = daysBetween(input.checkIn, input.checkOut);
  if (nights <= 0) return false;
  return input.alreadyBooked < input.totalInventory;
}

/**
 * Phase D: marketplace multi-hotel availability search.
 *
 * Returns one cheapest offer per hotel for hotels matching the (optional) city
 * filter. Only considers hotels that are tenant-active AND on a Plan that
 * opts-in to marketplace (`Plan.supportsMarketplace = true`) AND have at least
 * one ACTIVE Property — same gates the marketplace home/search pages enforce.
 *
 * The implementation deliberately reuses `findAvailableRoomType` per hotel so
 * inventory math, capacity checks, and SaaS-status guards stay in one place.
 * That keeps the marketplace and the existing single-tenant `/guest` portal
 * mathematically identical to the WhatsApp booking flow.
 */
export type MarketplaceOffer = RoomOffer & {
  hotelId: string;
  hotelSlug: string;
  hotelDisplayName: string;
  hotelCity: string | null;
  hotelStarRating: number | null;
  hotelCoverImageUrl: string | null;
};

export async function findAvailableAcrossHotels(params: {
  city?: string;
  checkIn: Date;
  checkOut: Date;
  guests: number;
  rooms: number;
  /** Cap result count for marketplace pagination. */
  limit?: number;
}): Promise<MarketplaceOffer[]> {
  const limit = Math.max(1, Math.min(100, params.limit ?? 30));
  const cityFilter = params.city?.trim();

  // Hotels eligible for marketplace exposure: tenant-active, has at least one
  // ACTIVE property, and is currently on a marketplace-enabled plan.
  // We accept a hotel if EITHER its cached subscriptionStatusCached is healthy
  // (TRIALING/ACTIVE) OR there is no subscription record yet (legacy seed data).
  const candidates = await prisma.hotel.findMany({
    where: {
      isActive: true,
      ...(cityFilter ? { city: { contains: cityFilter } } : {}),
      properties: { some: { status: PropertyStatus.ACTIVE } }
    },
    select: {
      id: true,
      slug: true,
      displayName: true,
      city: true,
      starRating: true,
      coverImageUrl: true,
      subscriptionStatusCached: true,
      subscriptionPlanCode: true
    },
    take: 200
  });

  if (!candidates.length) return [];

  // Resolve marketplace-enabled plan codes once.
  const marketplacePlans = await prisma.plan.findMany({
    where: { supportsMarketplace: true, isActive: true },
    select: { code: true }
  });
  const marketplacePlanCodes = new Set(marketplacePlans.map((p) => p.code));
  const marketplaceGateOpen = marketplacePlanCodes.size > 0;

  const eligible = candidates.filter((h) => {
    if (!marketplaceGateOpen) {
      // No marketplace-enabled plan exists yet → keep marketplace open to all
      // tenant-active hotels so the surface is testable; once founder defines
      // a marketplace plan, the gate flips closed automatically.
      return true;
    }
    if (!h.subscriptionPlanCode) return false;
    return marketplacePlanCodes.has(h.subscriptionPlanCode);
  });

  const offers: MarketplaceOffer[] = [];
  for (const hotel of eligible) {
    const offer = await findAvailableRoomType({
      hotelId: hotel.id,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guests: params.guests,
      rooms: params.rooms
    });
    if (!offer) continue;
    offers.push({
      ...offer,
      hotelId: hotel.id,
      hotelSlug: hotel.slug,
      hotelDisplayName: hotel.displayName,
      hotelCity: hotel.city,
      hotelStarRating: hotel.starRating,
      hotelCoverImageUrl: hotel.coverImageUrl
    });
    if (offers.length >= limit) break;
  }

  offers.sort((a, b) => a.total - b.total);
  return offers;
}
