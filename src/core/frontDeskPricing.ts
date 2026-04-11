import fs from "node:fs";
import path from "node:path";

export type MealPlanCode = "NONE" | "BREAKFAST" | "HALF_BOARD" | "FULL_BOARD";

export type FrontDeskExtra = {
  id: string;
  label: string;
  amount: number;
  /** multiply amount by number of nights */
  applyPerNight: boolean;
  /** multiply amount by hours (e.g. bike rental); exclusive with applyPerNight */
  applyPerHour: boolean;
};

export type FrontDeskPricingConfig = {
  mealPlans: Record<
    MealPlanCode,
    {
      perPersonPerNight: number;
    }
  >;
  extras: FrontDeskExtra[];
};

const configPath = path.join(process.cwd(), "front-desk-pricing.json");

const defaults: FrontDeskPricingConfig = {
  mealPlans: {
    NONE: { perPersonPerNight: 0 },
    BREAKFAST: { perPersonPerNight: 4 },
    HALF_BOARD: { perPersonPerNight: 15 },
    FULL_BOARD: { perPersonPerNight: 28 }
  },
  extras: [
    { id: "airport_transfer", label: "Airport transfer (one-way)", amount: 25, applyPerNight: false, applyPerHour: false },
    { id: "extra_bed", label: "Extra bed", amount: 10, applyPerNight: true, applyPerHour: false },
    { id: "bike_rent", label: "Bikes rent", amount: 10, applyPerNight: false, applyPerHour: true }
  ]
};

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
      if (m && typeof m === "object" && typeof (m as { perPersonPerNight?: unknown }).perPersonPerNight === "number") {
        next.mealPlans[key] = {
          perPersonPerNight: Math.max(0, Number((m as { perPersonPerNight: number }).perPersonPerNight))
        };
      }
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

export type ManualCheckInTotalInput = {
  baseNightlyRate: number;
  nights: number;
  mealPlan: MealPlanCode;
  adults: number;
  children: number;
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
  const pax = Math.max(0, adults) + Math.max(0, children);
  const roomSubtotal = Number((Math.max(0, baseNightlyRate) * Math.max(1, nights)).toFixed(2));
  const mealRate = pricing.mealPlans[mealPlan]?.perPersonPerNight ?? 0;
  const mealSubtotal = Number((mealRate * pax * Math.max(1, nights)).toFixed(2));

  const breakdown: { label: string; amount: number }[] = [
    { label: "Room (rack × nights)", amount: roomSubtotal },
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

/** Meal-plan add-on for WhatsApp quotes (room total is separate). */
export function computeMealPlanSurchargeForStay(params: {
  mealPlan: MealPlanCode;
  adults: number;
  children: number;
  nights: number;
}): number {
  const pricing = loadFrontDeskPricing();
  const pax = Math.max(0, params.adults) + Math.max(0, params.children);
  const rate = pricing.mealPlans[params.mealPlan]?.perPersonPerNight ?? 0;
  return Number((rate * pax * Math.max(1, params.nights)).toFixed(2));
}
