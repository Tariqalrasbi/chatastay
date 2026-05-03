import fs from "node:fs";
import path from "node:path";

export type MealPlanCode = "NONE" | "BREAKFAST" | "HALF_BOARD" | "FULL_BOARD";

/** How meal-plan surcharge is applied for quotes and folio-style estimates. */
export type MealPlanPricingMode = "PER_ROOM_PER_NIGHT" | "PER_GUEST_PER_NIGHT";

export type FrontDeskExtra = {
  id: string;
  label: string;
  amount: number;
  /** multiply amount by number of nights */
  applyPerNight: boolean;
  /** multiply amount by hours (e.g. bike rental); exclusive with applyPerNight */
  applyPerHour: boolean;
};

export type MealPlanPricingRow = {
  /** Default: per room per night (hotel industry standard for board). */
  pricingMode?: MealPlanPricingMode;
  /** OMR (or hotel currency) per room per night when pricingMode is PER_ROOM_PER_NIGHT (or legacy default). */
  perRoomPerNight?: number;
  /** OMR per guest per night when pricingMode is PER_GUEST_PER_NIGHT. */
  perGuestPerNight?: number;
  /** @deprecated Legacy key — when no pricingMode/perRoomPerNight, treated as per-room-per-night for backward compatibility. */
  perPersonPerNight?: number;
};

export type FrontDeskPricingConfig = {
  mealPlans: Record<MealPlanCode, MealPlanPricingRow>;
  extras: FrontDeskExtra[];
};

const configPath = path.join(process.cwd(), "front-desk-pricing.json");

const defaults: FrontDeskPricingConfig = {
  mealPlans: {
    NONE: { pricingMode: "PER_ROOM_PER_NIGHT", perRoomPerNight: 0 },
    BREAKFAST: { pricingMode: "PER_ROOM_PER_NIGHT", perRoomPerNight: 4 },
    HALF_BOARD: { pricingMode: "PER_ROOM_PER_NIGHT", perRoomPerNight: 15 },
    FULL_BOARD: { pricingMode: "PER_ROOM_PER_NIGHT", perRoomPerNight: 28 }
  },
  extras: [
    { id: "airport_transfer", label: "Airport transfer (one-way)", amount: 25, applyPerNight: false, applyPerHour: false },
    { id: "extra_bed", label: "Extra bed", amount: 10, applyPerNight: true, applyPerHour: false },
    { id: "bike_rent", label: "Bikes rent", amount: 10, applyPerNight: false, applyPerHour: true }
  ]
};

function normalizeMealPlanRow(raw: unknown, fallbackPerPerson: number): MealPlanPricingRow {
  if (!raw || typeof raw !== "object") {
    return { pricingMode: "PER_ROOM_PER_NIGHT", perRoomPerNight: Math.max(0, fallbackPerPerson) };
  }
  const o = raw as Record<string, unknown>;
  const modeRaw = String(o.pricingMode ?? "").toUpperCase();
  const mode: MealPlanPricingMode =
    modeRaw === "PER_GUEST_PER_NIGHT" ? "PER_GUEST_PER_NIGHT" : "PER_ROOM_PER_NIGHT";

  const perRoom = typeof o.perRoomPerNight === "number" ? Math.max(0, o.perRoomPerNight) : undefined;
  const perGuest = typeof o.perGuestPerNight === "number" ? Math.max(0, o.perGuestPerNight) : undefined;
  const legacy = typeof o.perPersonPerNight === "number" ? Math.max(0, o.perPersonPerNight) : undefined;

  if (mode === "PER_GUEST_PER_NIGHT") {
    const rate = perGuest ?? legacy ?? fallbackPerPerson;
    return { pricingMode: "PER_GUEST_PER_NIGHT", perGuestPerNight: rate };
  }

  // PER_ROOM_PER_NIGHT: prefer explicit perRoomPerNight; else migrate legacy perPersonPerNight as room-night rate.
  const rate = perRoom ?? legacy ?? fallbackPerPerson;
  return { pricingMode: "PER_ROOM_PER_NIGHT", perRoomPerNight: rate };
}

function sanitizeConfig(raw: unknown): FrontDeskPricingConfig {
  if (!raw || typeof raw !== "object") return defaults;
  const o = raw as Record<string, unknown>;
  const mealPlans = o.mealPlans;
  const extras = o.extras;
  const next: FrontDeskPricingConfig = {
    mealPlans: { ...defaults.mealPlans },
    extras: Array.isArray(extras)
      ? extras
          .filter((x): x is FrontDeskExtra => {
            if (!x || typeof x !== "object") return false;
            const e = x as Record<string, unknown>;
            return typeof e.id === "string" && typeof e.label === "string" && typeof e.amount === "number";
          })
          .map((row) => {
            const e = row as Record<string, unknown>;
            const applyPerHour = Boolean(e.applyPerHour);
            const applyPerNight = Boolean(e.applyPerNight) && !applyPerHour;
            return {
              id: String(e.id),
              label: String(e.label),
              amount: Math.max(0, Number(e.amount)),
              applyPerNight,
              applyPerHour
            };
          })
      : defaults.extras
  };
  if (mealPlans && typeof mealPlans === "object") {
    for (const key of ["NONE", "BREAKFAST", "HALF_BOARD", "FULL_BOARD"] as const) {
      const m = (mealPlans as Record<string, unknown>)[key];
      const legacyDefault = defaults.mealPlans[key].perRoomPerNight ?? 0;
      next.mealPlans[key] = normalizeMealPlanRow(m, legacyDefault);
    }
  }
  return next;
}

export function loadFrontDeskPricing(): FrontDeskPricingConfig {
  try {
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), "utf8");
      return defaults;
    }
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    return sanitizeConfig(parsed);
  } catch {
    return defaults;
  }
}

/** Resolved numeric rate used in the formula line (per room per night or per guest per night). */
export function getMealPlanUnitRate(mealPlan: MealPlanCode): { mode: MealPlanPricingMode; rate: number } {
  const pricing = loadFrontDeskPricing();
  const row = pricing.mealPlans[mealPlan] ?? { pricingMode: "PER_ROOM_PER_NIGHT" as const, perRoomPerNight: 0 };
  const mode = row.pricingMode ?? "PER_ROOM_PER_NIGHT";
  if (mode === "PER_GUEST_PER_NIGHT") {
    return { mode, rate: row.perGuestPerNight ?? row.perPersonPerNight ?? 0 };
  }
  return { mode, rate: row.perRoomPerNight ?? row.perPersonPerNight ?? 0 };
}

export type ManualCheckInTotalInput = {
  baseNightlyRate: number;
  nights: number;
  mealPlan: MealPlanCode;
  adults: number;
  children: number;
  /** Physical rooms for the stay (manual check-in form is one room). */
  rooms?: number;
  selectedExtraIds: string[];
  /** Hours for extras with applyPerHour (default 1) */
  extraHoursById?: Record<string, number>;
};

export function computeManualCheckInTotal(params: ManualCheckInTotalInput): {
  roomSubtotal: number;
  mealSubtotal: number;
  extrasSubtotal: number;
  total: number;
  breakdown: { label: string; amount: number }[];
} {
  const pricing = loadFrontDeskPricing();
  const { baseNightlyRate, nights, mealPlan, adults, children } = params;
  const rooms = Math.max(1, params.rooms ?? 1);
  const roomSubtotal = Number((Math.max(0, baseNightlyRate) * rooms * Math.max(1, nights)).toFixed(2));
  const mealSubtotal = computeMealPlanSurchargeForStay({
    mealPlan,
    adults,
    children,
    nights,
    rooms
  });

  const breakdown: { label: string; amount: number }[] = [
    { label: `Room (rack × ${rooms} room(s) × ${nights} night(s))`, amount: roomSubtotal },
    { label: `Meals (${mealPlan})`, amount: mealSubtotal }
  ];

  let extrasSubtotal = 0;
  const idSet = new Set(params.selectedExtraIds);
  const hoursMap = params.extraHoursById ?? {};
  for (const extra of pricing.extras) {
    if (!idSet.has(extra.id)) continue;
    let part: number;
    if (extra.applyPerHour) {
      const h = Math.max(0.25, Math.min(168, hoursMap[extra.id] ?? 1));
      part = Number((extra.amount * h).toFixed(2));
      breakdown.push({ label: `${extra.label} (${h} h)`, amount: part });
    } else if (extra.applyPerNight) {
      part = Number((extra.amount * Math.max(1, nights)).toFixed(2));
      breakdown.push({ label: extra.label, amount: part });
    } else {
      part = Number(extra.amount.toFixed(2));
      breakdown.push({ label: extra.label, amount: part });
    }
    extrasSubtotal += part;
  }
  extrasSubtotal = Number(extrasSubtotal.toFixed(2));
  const total = Number((roomSubtotal + mealSubtotal + extrasSubtotal).toFixed(2));
  return { roomSubtotal, mealSubtotal, extrasSubtotal, total, breakdown };
}

/**
 * Meal-plan surcharge for a stay: default **rooms × nights × rate** (per room per night).
 * Optional `PER_GUEST_PER_NIGHT`: (adults + children) × nights × rate.
 */
export function computeMealPlanSurchargeForStay(params: {
  mealPlan: MealPlanCode;
  adults: number;
  children: number;
  nights: number;
  /** Number of booked rooms; defaults to 1. */
  rooms?: number;
}): number {
  const { mealPlan, adults, children, nights } = params;
  const rooms = Math.max(1, params.rooms ?? 1);
  const { mode, rate } = getMealPlanUnitRate(mealPlan);
  if (rate <= 0 || mealPlan === "NONE") return 0;
  const n = Math.max(1, nights);
  if (mode === "PER_GUEST_PER_NIGHT") {
    const pax = Math.max(0, adults) + Math.max(0, children);
    return Number((rate * pax * n).toFixed(2));
  }
  return Number((rate * rooms * n).toFixed(2));
}

/** Human-readable meal surcharge line for WhatsApp quotes and confirmations. */
export function formatMealPlanSurchargeExplanation(params: {
  mealPlan: MealPlanCode;
  adults: number;
  children: number;
  nights: number;
  rooms: number;
  currency: string;
}): string {
  const amount = computeMealPlanSurchargeForStay(params);
  if (amount <= 0 || params.mealPlan === "NONE") {
    return `Meal plan: None (room only)`;
  }
  const { mode, rate } = getMealPlanUnitRate(params.mealPlan);
  const rooms = Math.max(1, params.rooms);
  const nights = Math.max(1, params.nights);
  if (mode === "PER_GUEST_PER_NIGHT") {
    const pax = Math.max(0, params.adults) + Math.max(0, params.children);
    return `Meal plan (${params.mealPlan}): ${pax} guest(s) × ${nights} night(s) × ${rate.toFixed(2)} ${params.currency}/guest/night = ${amount.toFixed(2)} ${params.currency}`;
  }
  return `Meal plan (${params.mealPlan}): ${rooms} room(s) × ${nights} night(s) × ${rate.toFixed(2)} ${params.currency}/room/night = ${amount.toFixed(2)} ${params.currency}`;
}
