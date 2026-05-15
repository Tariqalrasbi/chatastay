import { findAvailableRoomTypes, type RoomOffer } from "./availability";
import { manualCheckInFitsRoomType } from "./roomOccupancy";

export type RoomStayAllocationLine = {
  roomTypeId: string;
  roomTypeName: string;
  adults: number;
  children: number;
};

/** Offer for one physical room on given dates (must match room type). */
export async function findRoomOfferForRoomType(params: {
  hotelId: string;
  checkIn: Date;
  checkOut: Date;
  roomTypeId: string;
  adults: number;
  children: number;
}): Promise<RoomOffer | null> {
  const guests = Math.max(1, params.adults + params.children);
  const offers = await findAvailableRoomTypes({
    hotelId: params.hotelId,
    checkIn: params.checkIn,
    checkOut: params.checkOut,
    guests,
    rooms: 1,
    adults: params.adults,
    children: params.children
  });
  return offers.find((o) => o.roomTypeId === params.roomTypeId) ?? null;
}

/**
 * Search small state space (≤6 rooms, ≤16 guests): find one valid split of adults/children
 * across identical room types, preferring more balanced occupancy (minimize variance of headcount).
 */
export function recommendSameTypeRoomAllocations(params: {
  roomType: { id: string; name: string; code: string; capacity: number };
  roomCount: number;
  totalAdults: number;
  totalChildren: number;
}): { ok: true; lines: RoomStayAllocationLine[] } | { ok: false; message: string } {
  const { roomType, roomCount } = params;
  const ra = Math.max(0, Math.floor(params.totalAdults));
  const rc = Math.max(0, Math.floor(params.totalChildren));
  if (ra + rc < 1) {
    return { ok: false, message: "At least one guest is required." };
  }
  if (roomCount < 1) {
    return { ok: false, message: "At least one room is required." };
  }

  const state = { best: null as Array<{ a: number; c: number }> | null, score: Number.POSITIVE_INFINITY };

  function dfs(roomsLeft: number, adultsLeft: number, childrenLeft: number, acc: Array<{ a: number; c: number }>): void {
    if (roomsLeft === 0) {
      if (adultsLeft !== 0 || childrenLeft !== 0) return;
      const heads = acc.map((x) => x.a + x.c);
      const mean = heads.reduce((s, h) => s + h, 0) / heads.length;
      const variance = heads.reduce((s, h) => s + (h - mean) * (h - mean), 0);
      const maxHead = Math.max(...heads);
      const score = variance * 100 + maxHead;
      if (score < state.score) {
        state.score = score;
        state.best = acc.map((x) => ({ ...x }));
      }
      return;
    }

    for (let a = 0; a <= adultsLeft; a += 1) {
      for (let c = 0; c <= childrenLeft; c += 1) {
        if (a + c < 1) continue;
        const fit = manualCheckInFitsRoomType(roomType, a, c);
        if (!fit.ok) continue;
        acc.push({ a, c });
        dfs(roomsLeft - 1, adultsLeft - a, childrenLeft - c, acc);
        acc.pop();
      }
    }
  }

  const estimatedBranches = Math.pow(Math.min(ra + rc + 1, 10), roomCount);
  if (estimatedBranches > 8000) {
    const quick = quickAllocateSameTypeRooms(roomType, roomCount, ra, rc);
    if (!quick) {
      return {
        ok: false,
        message: `Cannot divide ${ra} adults and ${rc} children across ${roomCount} × ${roomType.name}. Try more rooms or another room type.`
      };
    }
    return { ok: true, lines: quick };
  }

  dfs(roomCount, ra, rc, []);

  if (!state.best) {
    return {
      ok: false,
      message: `Cannot divide ${ra} adults and ${rc} children across ${roomCount} × ${roomType.name}. Try more rooms or another room type.`
    };
  }
  const lines: RoomStayAllocationLine[] = state.best.map((p) => ({
    roomTypeId: roomType.id,
    roomTypeName: roomType.name,
    adults: p.a,
    children: p.c
  }));
  return { ok: true, lines };
}

/** Fast path for larger party/room counts: round-robin then local repair. */
function quickAllocateSameTypeRooms(
  roomType: { id: string; name: string; code: string; capacity: number },
  roomCount: number,
  ra: number,
  rc: number
): RoomStayAllocationLine[] | null {
  const lines: Array<{ a: number; c: number }> = Array.from({ length: roomCount }, () => ({ a: 0, c: 0 }));
  let ai = 0;
  for (let k = 0; k < ra; k += 1) {
    lines[ai % roomCount]!.a += 1;
    ai += 1;
  }
  let ci = 0;
  for (let k = 0; k < rc; k += 1) {
    lines[ci % roomCount]!.c += 1;
    ci += 1;
  }
  for (let guard = 0; guard < 80; guard += 1) {
    let badIdx = -1;
    for (let i = 0; i < roomCount; i += 1) {
      const h = lines[i]!.a + lines[i]!.c;
      if (h < 1) {
        badIdx = i;
        break;
      }
      if (!manualCheckInFitsRoomType(roomType, lines[i]!.a, lines[i]!.c).ok) {
        badIdx = i;
        break;
      }
    }
    if (badIdx < 0) {
      return lines.map((p) => ({
        roomTypeId: roomType.id,
        roomTypeName: roomType.name,
        adults: p.a,
        children: p.c
      }));
    }
    const donor = lines.findIndex((_, j) => j !== badIdx && lines[j]!.a + lines[j]!.c > 1);
    if (donor < 0) return null;
    if (lines[donor]!.a > 0) {
      lines[donor]!.a -= 1;
      lines[badIdx]!.a += 1;
    } else if (lines[donor]!.c > 0) {
      lines[donor]!.c -= 1;
      lines[badIdx]!.c += 1;
    } else {
      return null;
    }
  }
  return null;
}

/** Parse "2,1|1,2" → two lines (adults, children); must sum to totals. */
export function parseManualPipeRoomPax(
  raw: string,
  roomCount: number,
  totalAdults: number,
  totalChildren: number,
  roomType: { id: string; name: string }
): { ok: true; lines: RoomStayAllocationLine[] } | { ok: false; message: string } {
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (!trimmed) {
    return { ok: false, message: "Please send guest counts per room, e.g. 2,1|1,2 (adults,children for each room, separated by |)." };
  }
  const parts = trimmed.split("|").map((p) => p.split(",").map((x) => x.trim()));
  if (parts.length !== roomCount) {
    return {
      ok: false,
      message: `Please send exactly ${roomCount} segments separated by | (one per room), e.g. 2,1|1,2 for adults,children in each room.`
    };
  }
  let sa = 0;
  let sc = 0;
  const lines: RoomStayAllocationLine[] = [];
  for (const pair of parts) {
    if (pair.length < 2) {
      return { ok: false, message: "Each room must be two numbers: adults,children (e.g. 2,1)." };
    }
    const a = parseInt(pair[0]!, 10);
    const c = parseInt(pair[1]!, 10);
    if (!Number.isFinite(a) || !Number.isFinite(c) || a < 0 || c < 0 || a + c < 1) {
      return { ok: false, message: "Use non-negative numbers; each room needs at least one guest." };
    }
    sa += a;
    sc += c;
    lines.push({ roomTypeId: roomType.id, roomTypeName: roomType.name, adults: a, children: c });
  }
  if (sa !== totalAdults || sc !== totalChildren) {
    return {
      ok: false,
      message: `Assigned ${sa} adults + ${sc} children, but your party is ${totalAdults} adults + ${totalChildren} children. Please balance the numbers.`
    };
  }
  return { ok: true, lines };
}

/** Parse comma-separated room type IDs length === roomCount (from a prior list). */
export function parseCommaRoomTypeIds(raw: string, roomCount: number, allowedIds: Set<string>): { ok: true; ids: string[] } | { ok: false; message: string } {
  const ids = raw
    .split(/[,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (ids.length !== roomCount) {
    return { ok: false, message: `Send exactly ${roomCount} room-type codes separated by commas (one per room).` };
  }
  for (const id of ids) {
    if (!allowedIds.has(id)) {
      return { ok: false, message: "One or more room types are not valid. Please use the IDs from the list." };
    }
  }
  return { ok: true, ids };
}
