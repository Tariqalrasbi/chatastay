import { BookingStatus } from "@prisma/client";
import { prisma } from "../db";

const MEMORY_VERSION = 1 as const;

export type SpendingLevel = "low" | "medium" | "high";

export type LightGuestMemory = {
  v: typeof MEMORY_VERSION;
  updatedAt: string;
  preferredRoomTypeId?: string | null;
  preferredRoomTypeName?: string | null;
  /** Normalized activity labels (e.g. dune_buggy, bbq). */
  preferredActivities?: string[];
  /** Short anonymized request lines (max 5). */
  specialRequestSnippets?: string[];
  confirmedStayCount?: number;
  averageStayNights?: number | null;
  spendingLevel?: SpendingLevel | null;
  lastStayCheckOut?: string | null;
  repeatGuest?: boolean;
  hadComplaint?: boolean;
  lastWelcomeMenuAt?: string | null;
  /** When true, suppress non-essential automated WhatsApp (post-stay, promos); stored in JSON without migration. */
  messagingDoNotDisturb?: boolean;
  /** When true, suppress promotional / return-stay automation; operational messages may still send. */
  messagingMarketingOptOut?: boolean;
};

function spendingLevelFromTotal(total: number, nights: number): SpendingLevel {
  const perNight = nights > 0 ? total / nights : total;
  if (total >= 220 || perNight >= 90) return "high";
  if (total >= 90 || perNight >= 35) return "medium";
  return "low";
}

export function parseLightGuestMemory(raw: string | null | undefined): LightGuestMemory {
  if (!raw) {
    return { v: MEMORY_VERSION, updatedAt: new Date().toISOString() };
  }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== "object" || o.v !== MEMORY_VERSION) {
      return { v: MEMORY_VERSION, updatedAt: new Date().toISOString() };
    }
    const activities = Array.isArray(o.preferredActivities)
      ? o.preferredActivities.filter((x): x is string => typeof x === "string").slice(0, 8)
      : undefined;
    const snippets = Array.isArray(o.specialRequestSnippets)
      ? o.specialRequestSnippets.filter((x): x is string => typeof x === "string").map((s) => s.slice(0, 120)).slice(0, 5)
      : undefined;
    const sl = o.spendingLevel;
    const spendingLevel: SpendingLevel | null | undefined =
      sl === "low" || sl === "medium" || sl === "high" ? sl : undefined;
    return {
      v: MEMORY_VERSION,
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : new Date().toISOString(),
      preferredRoomTypeId: typeof o.preferredRoomTypeId === "string" ? o.preferredRoomTypeId : null,
      preferredRoomTypeName: typeof o.preferredRoomTypeName === "string" ? o.preferredRoomTypeName : null,
      preferredActivities: activities,
      specialRequestSnippets: snippets,
      confirmedStayCount: typeof o.confirmedStayCount === "number" ? o.confirmedStayCount : undefined,
      averageStayNights: typeof o.averageStayNights === "number" ? o.averageStayNights : null,
      spendingLevel: spendingLevel ?? null,
      lastStayCheckOut: typeof o.lastStayCheckOut === "string" ? o.lastStayCheckOut : null,
      repeatGuest: typeof o.repeatGuest === "boolean" ? o.repeatGuest : undefined,
      hadComplaint: typeof o.hadComplaint === "boolean" ? o.hadComplaint : undefined,
      lastWelcomeMenuAt: typeof o.lastWelcomeMenuAt === "string" ? o.lastWelcomeMenuAt : null,
      messagingDoNotDisturb: typeof o.messagingDoNotDisturb === "boolean" ? o.messagingDoNotDisturb : undefined,
      messagingMarketingOptOut: typeof o.messagingMarketingOptOut === "boolean" ? o.messagingMarketingOptOut : undefined
    };
  } catch {
    return { v: MEMORY_VERSION, updatedAt: new Date().toISOString() };
  }
}

export async function loadGuestMemoryContext(guestId: string): Promise<{
  memory: LightGuestMemory;
  confirmedStayCount: number;
}> {
  const [row, confirmedStayCount] = await Promise.all([
    prisma.guest.findUnique({
      where: { id: guestId },
      select: { lightGuestMemoryJson: true }
    }),
    prisma.booking.count({
      where: { guestId, status: BookingStatus.CONFIRMED }
    })
  ]);
  const memory = parseLightGuestMemory(row?.lightGuestMemoryJson ?? null);
  return { memory, confirmedStayCount };
}

async function persistGuestMemory(guestId: string, next: LightGuestMemory): Promise<void> {
  const payload: LightGuestMemory = { ...next, v: MEMORY_VERSION, updatedAt: new Date().toISOString() };
  await prisma.guest.update({
    where: { id: guestId },
    data: { lightGuestMemoryJson: JSON.stringify(payload) }
  });
}

/** After a WhatsApp-confirmed stay is created, refresh aggregates and preferences (room from booking). */
export async function mergeLightGuestMemoryFromConfirmedBooking(params: {
  guestId: string;
  roomTypeId: string;
  roomTypeName: string;
  nights: number;
  totalAmount: number;
  checkOut: Date;
}): Promise<void> {
  const row = await prisma.guest.findUnique({
    where: { id: params.guestId },
    select: { lightGuestMemoryJson: true }
  });
  const prev = parseLightGuestMemory(row?.lightGuestMemoryJson ?? null);
  const [confirmedStayCount, avgRow] = await Promise.all([
    prisma.booking.count({
      where: { guestId: params.guestId, status: BookingStatus.CONFIRMED }
    }),
    prisma.booking.aggregate({
      where: { guestId: params.guestId, status: BookingStatus.CONFIRMED },
      _avg: { nights: true }
    })
  ]);
  const averageStayNights = avgRow._avg.nights ?? params.nights;

  const next: LightGuestMemory = {
    ...prev,
    preferredRoomTypeId: params.roomTypeId,
    preferredRoomTypeName: params.roomTypeName,
    confirmedStayCount,
    averageStayNights: Number(Number(averageStayNights).toFixed(2)),
    spendingLevel: spendingLevelFromTotal(params.totalAmount, params.nights),
    lastStayCheckOut: params.checkOut.toISOString().slice(0, 10),
    repeatGuest: confirmedStayCount >= 2
  };
  await persistGuestMemory(params.guestId, next);
}

/** When meal plan or folio adjusts total after atomic create, realign spending band only. */
export async function mergeLightGuestMemorySpendingTouch(params: {
  guestId: string;
  totalAmount: number;
  nights: number;
}): Promise<void> {
  const row = await prisma.guest.findUnique({
    where: { id: params.guestId },
    select: { lightGuestMemoryJson: true }
  });
  const prev = parseLightGuestMemory(row?.lightGuestMemoryJson ?? null);
  await persistGuestMemory(params.guestId, {
    ...prev,
    spendingLevel: spendingLevelFromTotal(params.totalAmount, Math.max(1, params.nights))
  });
}

export async function noteGuestComplaintInMemory(guestId: string): Promise<void> {
  const row = await prisma.guest.findUnique({
    where: { id: guestId },
    select: { lightGuestMemoryJson: true }
  });
  const prev = parseLightGuestMemory(row?.lightGuestMemoryJson ?? null);
  await persistGuestMemory(guestId, { ...prev, hadComplaint: true });
}

const ACTIVITY_KEYWORDS: Array<{ re: RegExp; key: string }> = [
  { re: /\bdune\s*buggy\b|\bsand\s*bike\b|\bsand\s*biking\b/i, key: "dune_buggy" },
  { re: /\bbbq\b|\bbarbecue\b|\bbarbeque\b/i, key: "bbq" },
  { re: /\btours?\b|\bexperiences?\b|\bactivities?\b/i, key: "experiences" }
];

export async function mergePreferredActivitiesFromText(guestId: string, text: string): Promise<void> {
  const t = text.toLowerCase();
  const hits = new Set<string>();
  for (const { re, key } of ACTIVITY_KEYWORDS) {
    if (re.test(t)) hits.add(key);
  }
  if (hits.size === 0) return;
  const row = await prisma.guest.findUnique({
    where: { id: guestId },
    select: { lightGuestMemoryJson: true }
  });
  const prev = parseLightGuestMemory(row?.lightGuestMemoryJson ?? null);
  const merged = new Set([...(prev.preferredActivities ?? []), ...hits]);
  await persistGuestMemory(guestId, {
    ...prev,
    preferredActivities: [...merged].slice(0, 8)
  });
}

export async function mergeSpecialRequestSnippet(guestId: string, text: string): Promise<void> {
  const line = text.replace(/\s+/g, " ").trim().slice(0, 120);
  if (line.length < 8) return;
  const row = await prisma.guest.findUnique({
    where: { id: guestId },
    select: { lightGuestMemoryJson: true }
  });
  const prev = parseLightGuestMemory(row?.lightGuestMemoryJson ?? null);
  const list = [...(prev.specialRequestSnippets ?? [])];
  if (!list.includes(line)) list.unshift(line);
  await persistGuestMemory(guestId, {
    ...prev,
    specialRequestSnippets: list.slice(0, 5)
  });
}

export async function recordWelcomeBackMenuShown(guestId: string): Promise<void> {
  const row = await prisma.guest.findUnique({
    where: { id: guestId },
    select: { lightGuestMemoryJson: true }
  });
  const prev = parseLightGuestMemory(row?.lightGuestMemoryJson ?? null);
  await persistGuestMemory(guestId, {
    ...prev,
    lastWelcomeMenuAt: new Date().toISOString()
  });
}

export function shouldShowWelcomeBackLine(memory: LightGuestMemory): boolean {
  if (!memory.lastWelcomeMenuAt) return true;
  const last = new Date(memory.lastWelcomeMenuAt).getTime();
  if (!Number.isFinite(last)) return true;
  return Date.now() - last > 7 * 24 * 60 * 60 * 1000;
}
