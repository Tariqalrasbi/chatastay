import { BookingStatus, ChannelProvider, SegmentTagKind } from "@prisma/client";
import { prisma } from "../db";

/** Stored on MarketingCampaign.filtersJson — v1 rule-based targeting. */
export type CampaignAudienceFilters = {
  vipOnly?: boolean;
  /** Guest must have at least one of these segment tags (GuestSegmentTag.tag). */
  matchAnySegmentTags?: SegmentTagKind[];
  /** Guest must have all of these tags. */
  matchAllSegmentTags?: SegmentTagKind[];
  minCompletedStays?: number;
  maxCompletedStays?: number;
  /** Sum of totalAmount on CONFIRMED bookings. */
  minLifetimeSpend?: number;
  maxLifetimeSpend?: number;
  /** Had a completed stay with check-out within the last N days. */
  lastCompletedStayWithinDays?: number;
  /** Last completed check-out was *before* now minus N days (lapsed / win-back). Requires ≥1 completed stay. */
  noCompletedStaySinceDays?: number;
  /** Had at least one CONFIRMED booking with this source. */
  bookingSourcesAny?: ChannelProvider[];
  /** Nationality contains (case-insensitive substring). */
  nationalityContains?: string;
  /** Guest locale equals one of these (e.g. en, ar). */
  localesAny?: string[];
  /** Ever had a CONFIRMED booking for this room type. */
  roomTypeIdsAny?: string[];
  /** Meal plan on any CONFIRMED booking (NONE, BREAKFAST, …). */
  mealPlansAny?: string[];
  minNightsOnAnyBooking?: number;
  maxNightsOnAnyBooking?: number;
};

export type CampaignGuestRow = {
  id: string;
  phoneE164: string;
  fullName: string | null;
  lightGuestMemoryJson?: string | null;
};

function daysToMs(d: number): number {
  return d * 24 * 60 * 60 * 1000;
}

function parseIntOpt(v: unknown): number | undefined {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseFloatOpt(v: unknown): number | undefined {
  const n = parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Parse Express `req.body` from campaign form. */
export function parseCampaignFiltersFromBody(body: Record<string, unknown>): CampaignAudienceFilters {
  const f: CampaignAudienceFilters = {};
  if (body.filterVip === "1" || body.filterVip === "on") f.vipOnly = true;

  const anyRaw = body.filterTagsAny;
  const anyArr = Array.isArray(anyRaw) ? anyRaw : anyRaw ? [anyRaw] : [];
  const allowed = new Set<string>(Object.values(SegmentTagKind));
  const matchAny = anyArr.map(String).filter((t) => allowed.has(t)) as SegmentTagKind[];
  if (matchAny.length) f.matchAnySegmentTags = matchAny;

  const allRaw = body.filterTagsAll;
  const allArr = Array.isArray(allRaw) ? allRaw : allRaw ? [allRaw] : [];
  const matchAll = allArr.map(String).filter((t) => allowed.has(t)) as SegmentTagKind[];
  if (matchAll.length) f.matchAllSegmentTags = matchAll;

  const minC = parseIntOpt(body.filterMinCompletedStays);
  if (minC !== undefined) f.minCompletedStays = minC;
  const maxC = parseIntOpt(body.filterMaxCompletedStays);
  if (maxC !== undefined) f.maxCompletedStays = maxC;

  const minS = parseFloatOpt(body.filterMinLifetimeSpend);
  if (minS !== undefined) f.minLifetimeSpend = minS;
  const maxS = parseFloatOpt(body.filterMaxLifetimeSpend);
  if (maxS !== undefined) f.maxLifetimeSpend = maxS;

  const recent = parseIntOpt(body.filterLastStayWithinDays);
  if (recent !== undefined && recent > 0) f.lastCompletedStayWithinDays = recent;

  const lapsed = parseIntOpt(body.filterNoStaySinceDays);
  if (lapsed !== undefined && lapsed > 0) f.noCompletedStaySinceDays = lapsed;

  const srcRaw = body.filterBookingSources;
  const srcArr = Array.isArray(srcRaw) ? srcRaw : srcRaw ? [srcRaw] : [];
  const chans = srcArr.map(String).filter((s): s is ChannelProvider =>
    Object.values(ChannelProvider).includes(s as ChannelProvider)
  );
  if (chans.length) f.bookingSourcesAny = chans;

  const nat = String(body.filterNationalityContains ?? "").trim();
  if (nat) f.nationalityContains = nat;

  const locRaw = body.filterLocales;
  const locArr = Array.isArray(locRaw) ? locRaw : locRaw ? [locRaw] : [];
  const locs = locArr.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (locs.length) f.localesAny = locs;

  const rtRaw = body.filterRoomTypeIds;
  const rtArr = Array.isArray(rtRaw) ? rtRaw : rtRaw ? [rtRaw] : [];
  const rts = rtArr.map(String).filter(Boolean);
  if (rts.length) f.roomTypeIdsAny = rts;

  const mpRaw = body.filterMealPlans;
  const mpArr = Array.isArray(mpRaw) ? mpRaw : mpRaw ? [mpRaw] : [];
  const mps = mpArr.map(String).filter(Boolean);
  if (mps.length) f.mealPlansAny = mps;

  const minN = parseIntOpt(body.filterMinNights);
  if (minN !== undefined) f.minNightsOnAnyBooking = minN;
  const maxN = parseIntOpt(body.filterMaxNights);
  if (maxN !== undefined) f.maxNightsOnAnyBooking = maxN;

  return f;
}

function guestMatchesFilters(
  row: {
    isVip: boolean;
    nationality: string | null;
    locale: string | null;
    tagSet: Set<SegmentTagKind>;
    confirmedBookings: Array<{
      checkOut: Date;
      totalAmount: number;
      source: ChannelProvider;
      nights: number;
      roomTypeId: string;
      mealPlan: string | null;
    }>;
  },
  f: CampaignAudienceFilters,
  now: Date
): boolean {
  if (f.vipOnly && !row.isVip) return false;

  if (f.matchAnySegmentTags?.length) {
    const ok = f.matchAnySegmentTags.some((t) => row.tagSet.has(t));
    if (!ok) return false;
  }
  if (f.matchAllSegmentTags?.length) {
    const ok = f.matchAllSegmentTags.every((t) => row.tagSet.has(t));
    if (!ok) return false;
  }

  const completed = row.confirmedBookings.filter((b) => b.checkOut.getTime() <= now.getTime());
  const completedCount = completed.length;
  const lifetimeSpend = row.confirmedBookings.reduce((s, b) => s + b.totalAmount, 0);

  if (f.minCompletedStays !== undefined && completedCount < f.minCompletedStays) return false;
  if (f.maxCompletedStays !== undefined && completedCount > f.maxCompletedStays) return false;

  if (f.minLifetimeSpend !== undefined && lifetimeSpend < f.minLifetimeSpend) return false;
  if (f.maxLifetimeSpend !== undefined && lifetimeSpend > f.maxLifetimeSpend) return false;

  let lastCompletedCheckout: Date | null = null;
  for (const b of completed) {
    if (!lastCompletedCheckout || b.checkOut.getTime() > lastCompletedCheckout.getTime()) {
      lastCompletedCheckout = b.checkOut;
    }
  }

  if (f.lastCompletedStayWithinDays !== undefined) {
    if (!lastCompletedCheckout) return false;
    const boundary = new Date(now.getTime() - daysToMs(f.lastCompletedStayWithinDays));
    if (lastCompletedCheckout.getTime() < boundary.getTime()) return false;
  }

  if (f.noCompletedStaySinceDays !== undefined) {
    if (!lastCompletedCheckout) return false;
    const boundary = new Date(now.getTime() - daysToMs(f.noCompletedStaySinceDays));
    if (lastCompletedCheckout.getTime() >= boundary.getTime()) return false;
  }

  if (f.bookingSourcesAny?.length) {
    const ok = row.confirmedBookings.some((b) => f.bookingSourcesAny!.includes(b.source));
    if (!ok) return false;
  }

  if (f.nationalityContains) {
    const needle = f.nationalityContains.trim().toLowerCase();
    const hay = (row.nationality ?? "").toLowerCase();
    if (!hay.includes(needle)) return false;
  }

  if (f.localesAny?.length) {
    const loc = (row.locale ?? "en").toLowerCase();
    if (!f.localesAny.includes(loc)) return false;
  }

  if (f.roomTypeIdsAny?.length) {
    const ok = row.confirmedBookings.some((b) => f.roomTypeIdsAny!.includes(b.roomTypeId));
    if (!ok) return false;
  }

  if (f.mealPlansAny?.length) {
    const ok = row.confirmedBookings.some((b) => {
      const mp = (b.mealPlan ?? "NONE").toUpperCase();
      return f.mealPlansAny!.some((m) => m.toUpperCase() === mp);
    });
    if (!ok) return false;
  }

  if (f.minNightsOnAnyBooking !== undefined) {
    const ok = row.confirmedBookings.some((b) => b.nights >= f.minNightsOnAnyBooking!);
    if (!ok) return false;
  }
  if (f.maxNightsOnAnyBooking !== undefined) {
    const ok = row.confirmedBookings.some((b) => b.nights <= f.maxNightsOnAnyBooking!);
    if (!ok) return false;
  }

  return true;
}

/**
 * Resolves eligible guests (must have phone). Filters are AND-combined where set.
 */
export async function resolveCampaignAudience(
  hotelId: string,
  filters: CampaignAudienceFilters
): Promise<{ guests: CampaignGuestRow[]; count: number }> {
  const now = new Date();

  const guests = await prisma.guest.findMany({
    where: {
      hotelId,
      phoneE164: { not: "" }
    },
    select: {
      id: true,
      phoneE164: true,
      fullName: true,
      lightGuestMemoryJson: true,
      isVip: true,
      nationality: true,
      locale: true,
      segmentTags: { select: { tag: true } },
      bookings: {
        where: { status: BookingStatus.CONFIRMED },
        select: {
          checkOut: true,
          totalAmount: true,
          source: true,
          nights: true,
          roomTypeId: true,
          mealPlan: true
        }
      }
    }
  });

  const out: CampaignGuestRow[] = [];

  for (const g of guests) {
    const tagSet = new Set(g.segmentTags.map((t) => t.tag));
    const row = {
      isVip: g.isVip,
      nationality: g.nationality,
      locale: g.locale,
      tagSet,
      confirmedBookings: g.bookings.map((b) => ({
        checkOut: b.checkOut,
        totalAmount: b.totalAmount,
        source: b.source,
        nights: b.nights,
        roomTypeId: b.roomTypeId,
        mealPlan: b.mealPlan
      }))
    };

    if (!guestMatchesFilters(row, filters, now)) continue;

    const phone = g.phoneE164?.trim();
    if (!phone || phone.length < 8) continue;

    out.push({ id: g.id, phoneE164: phone, fullName: g.fullName, lightGuestMemoryJson: g.lightGuestMemoryJson });
  }

  return { guests: out, count: out.length };
}

export function serializeCampaignFilters(f: CampaignAudienceFilters): string {
  return JSON.stringify(f);
}

export function deserializeCampaignFilters(json: string): CampaignAudienceFilters {
  try {
    return JSON.parse(json) as CampaignAudienceFilters;
  } catch {
    return {};
  }
}

/** True when no targeting constraint is set — mass-send guard should require explicit acknowledgement. */
export function isCampaignFiltersEmpty(f: CampaignAudienceFilters): boolean {
  return (
    !f.vipOnly &&
    !(f.matchAnySegmentTags?.length) &&
    !(f.matchAllSegmentTags?.length) &&
    f.minCompletedStays === undefined &&
    f.maxCompletedStays === undefined &&
    f.minLifetimeSpend === undefined &&
    f.maxLifetimeSpend === undefined &&
    f.lastCompletedStayWithinDays === undefined &&
    f.noCompletedStaySinceDays === undefined &&
    !(f.bookingSourcesAny?.length) &&
    !f.nationalityContains?.trim() &&
    !(f.localesAny?.length) &&
    !(f.roomTypeIdsAny?.length) &&
    !(f.mealPlansAny?.length) &&
    f.minNightsOnAnyBooking === undefined &&
    f.maxNightsOnAnyBooking === undefined
  );
}
