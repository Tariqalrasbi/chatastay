import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/**
 * Server-side draft model for the multi-step partner onboarding wizard.
 *
 * Why server-side: partners must be able to save and continue later from any
 * device, and we don't want to leak tenant-shaped data through cookies. Each
 * draft is identified by an unguessable token in the URL; the wizard step
 * pages and forms thread the token through.
 */

export const ONBOARDING_TOTAL_STEPS = 10;
export const ONBOARDING_DRAFT_TTL_DAYS = 30;

export type OnboardingRoomTypePayload = {
  presetCode?: string;
  name: string;
  capacity?: number;
  maxAdults?: number;
  maxChildren?: number;
  bedConfig?: string;
  roomSizeSqm?: number;
  smokingAllowed?: boolean;
  description?: string;
  baseNightlyRate?: number;
  lowSeasonRate?: number;
  highSeasonRate?: number;
  breakfastIncludedRate?: number;
  halfBoardSurcharge?: number;
  fullBoardSurcharge?: number;
  extraBedAvailable?: boolean;
  extraBedRate?: number;
  cancellationRule?: string;
  units?: Array<{ name: string; floor?: string; building?: string }>;
};

export type OnboardingMealPlanRow = {
  enabled?: boolean;
  pricePerPerson?: number | null;
  pricePerRoom?: number | null;
  serviceWindow?: string;
  notes?: string;
};

export type OnboardingFaqEntry = {
  question?: string;
  answer: string;
  locale?: string;
  category?: string;
};

export type OnboardingStaffInvite = {
  fullName: string;
  email: string;
  role: string;
};

export type OnboardingDraftPayload = {
  basics?: {
    propertyName?: string;
    hotelType?: string;
    starRating?: number;
    city?: string;
    country?: string;
    addressLine1?: string;
    googleMapsUrl?: string;
    phone?: string;
    whatsappPhone?: string;
    contactEmail?: string;
    websiteUrl?: string;
    timezone?: string;
    currency?: string;
    checkInTime?: string;
    checkOutTime?: string;
  };
  branding?: {
    logoUrl?: string;
    primaryColor?: string;
    coverImageUrl?: string;
    photoUrls?: string[];
    descriptionEn?: string;
    descriptionAr?: string;
    amenities?: string[];
  };
  rooms?: {
    types?: OnboardingRoomTypePayload[];
  };
  rates?: {
    /** When true, partner has confirmed their seasonal rates step. */
    confirmed?: boolean;
    extraBedRate?: number;
  };
  mealPlans?: {
    breakfast?: OnboardingMealPlanRow;
    halfBoard?: OnboardingMealPlanRow;
    fullBoard?: OnboardingMealPlanRow;
  };
  policies?: {
    cancellation?: string;
    checkIn?: string;
    payment?: string;
    child?: string;
    smoking?: string;
    pets?: string;
    idRequirement?: string;
  };
  services?: {
    activities?: string;
    rentals?: string;
    extraServices?: string;
    hasRestaurant?: boolean;
    restaurantHours?: string;
    hasCoffeeShop?: boolean;
    hasRoomService?: boolean;
  };
  knowledge?: {
    welcomeEn?: string;
    welcomeAr?: string;
    faqs?: OnboardingFaqEntry[];
  };
  staff?: {
    invites?: OnboardingStaffInvite[];
  };
  owner?: {
    fullName?: string;
    email?: string;
    /** Stored only inside the draft; never echoed back to the page. */
    password?: string;
    defaultLanguage?: string;
  };
  /** Steps the partner has saved at least once. */
  completedSteps?: number[];
};

export type OnboardingDraftRecord = {
  id: string;
  token: string;
  planCode: string;
  ownerEmail: string | null;
  payload: OnboardingDraftPayload;
  lastStep: number;
  completedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

function generateOnboardingToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function safeParsePayload(raw: string | null | undefined): OnboardingDraftPayload {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as OnboardingDraftPayload;
    }
  } catch {
    return {};
  }
  return {};
}

function clampPlanCode(planCodeRaw: string | null | undefined): string {
  const code = String(planCodeRaw ?? "growth").trim().toLowerCase();
  return ["starter", "growth", "pro"].includes(code) ? code : "growth";
}

function normalizeStepIndex(rawStep: unknown): number {
  const n = Math.floor(Number(rawStep));
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > ONBOARDING_TOTAL_STEPS) return ONBOARDING_TOTAL_STEPS;
  return n;
}

export function progressPercent(lastStep: number): number {
  const safeStep = normalizeStepIndex(lastStep);
  return Math.round(((safeStep - 1) / ONBOARDING_TOTAL_STEPS) * 100);
}

export function completionPercent(completedSteps: number[] | undefined): number {
  const valid = (completedSteps ?? []).filter(
    (step) => Number.isInteger(step) && step >= 1 && step <= ONBOARDING_TOTAL_STEPS
  );
  const unique = Array.from(new Set(valid));
  return Math.round((unique.length / ONBOARDING_TOTAL_STEPS) * 100);
}

function toRecord(row: {
  id: string;
  token: string;
  planCode: string;
  ownerEmail: string | null;
  payloadJson: string;
  lastStep: number;
  completedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): OnboardingDraftRecord {
  return {
    id: row.id,
    token: row.token,
    planCode: row.planCode,
    ownerEmail: row.ownerEmail,
    payload: safeParsePayload(row.payloadJson),
    lastStep: normalizeStepIndex(row.lastStep),
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function loadOnboardingDraftByToken(
  prisma: PrismaClient,
  token: string
): Promise<OnboardingDraftRecord | null> {
  const value = String(token ?? "").trim();
  if (!value) return null;
  const draft = await prisma.onboardingDraft.findUnique({ where: { token: value } });
  if (!draft) return null;
  if (draft.completedAt) return null;
  if (draft.expiresAt.getTime() < Date.now()) return null;
  return toRecord(draft);
}

export async function createOnboardingDraft(
  prisma: PrismaClient,
  options: { planCode?: string; ownerEmail?: string | null } = {}
): Promise<OnboardingDraftRecord> {
  const planCode = clampPlanCode(options.planCode ?? null);
  const expiresAt = new Date(Date.now() + ONBOARDING_DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateOnboardingToken();
    try {
      const draft = await prisma.onboardingDraft.create({
        data: {
          token,
          planCode,
          ownerEmail: options.ownerEmail ?? null,
          payloadJson: JSON.stringify({ completedSteps: [] }),
          lastStep: 1,
          expiresAt
        }
      });
      return toRecord(draft);
    } catch {
      // Highly unlikely token collision; retry with a fresh token.
      continue;
    }
  }
  throw new Error("Could not allocate an onboarding draft token");
}

function mergePayload(
  current: OnboardingDraftPayload,
  patch: OnboardingDraftPayload
): OnboardingDraftPayload {
  const next: OnboardingDraftPayload = { ...current };
  for (const key of Object.keys(patch) as (keyof OnboardingDraftPayload)[]) {
    if (key === "completedSteps") continue;
    const incoming = patch[key];
    if (incoming === undefined) continue;
    if (Array.isArray(incoming)) {
      (next as Record<string, unknown>)[key] = incoming;
    } else if (incoming && typeof incoming === "object") {
      const prev = (current[key] && typeof current[key] === "object" ? current[key] : {}) as Record<string, unknown>;
      (next as Record<string, unknown>)[key] = { ...prev, ...(incoming as Record<string, unknown>) };
    } else {
      (next as Record<string, unknown>)[key] = incoming;
    }
  }
  if (patch.completedSteps) {
    const merged = new Set([...(current.completedSteps ?? []), ...patch.completedSteps]);
    next.completedSteps = Array.from(merged).sort((a, b) => a - b);
  }
  return next;
}

export async function saveOnboardingDraftStep(
  prisma: PrismaClient,
  token: string,
  step: number,
  patch: OnboardingDraftPayload
): Promise<OnboardingDraftRecord> {
  const current = await loadOnboardingDraftByToken(prisma, token);
  if (!current) {
    throw new Error("Draft not found or expired");
  }
  const safeStep = normalizeStepIndex(step);
  const completedSet = new Set([...(current.payload.completedSteps ?? []), safeStep]);
  const merged = mergePayload(current.payload, {
    ...patch,
    completedSteps: Array.from(completedSet)
  });
  const nextLastStep = Math.min(
    ONBOARDING_TOTAL_STEPS,
    Math.max(current.lastStep, safeStep + 1)
  );
  const updated = await prisma.onboardingDraft.update({
    where: { token: current.token },
    data: {
      payloadJson: JSON.stringify(merged),
      lastStep: nextLastStep,
      ownerEmail: merged.owner?.email ?? merged.basics?.contactEmail ?? current.ownerEmail
    }
  });
  return toRecord(updated);
}

export async function setOnboardingPlan(
  prisma: PrismaClient,
  token: string,
  planCodeRaw: string
): Promise<OnboardingDraftRecord | null> {
  const current = await loadOnboardingDraftByToken(prisma, token);
  if (!current) return null;
  const planCode = clampPlanCode(planCodeRaw);
  if (planCode === current.planCode) return current;
  const updated = await prisma.onboardingDraft.update({
    where: { token: current.token },
    data: { planCode }
  });
  return toRecord(updated);
}

export async function markOnboardingDraftComplete(
  prisma: PrismaClient,
  token: string
): Promise<void> {
  await prisma.onboardingDraft.updateMany({
    where: { token },
    data: { completedAt: new Date(), lastStep: ONBOARDING_TOTAL_STEPS }
  });
}

export async function pruneExpiredOnboardingDrafts(prisma: PrismaClient): Promise<number> {
  const result = await prisma.onboardingDraft.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { completedAt: { not: null, lt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } }
      ]
    }
  });
  return result.count;
}

export const STANDARD_ROOM_TYPE_PRESETS: Array<{ code: string; label: string; defaultBeds: string; capacity: number }> = [
  { code: "STANDARD", label: "Standard Room", defaultBeds: "1 QUEEN", capacity: 2 },
  { code: "DELUXE", label: "Deluxe Room", defaultBeds: "1 KING", capacity: 2 },
  { code: "SUPERIOR", label: "Superior Room", defaultBeds: "1 KING", capacity: 2 },
  { code: "EXECUTIVE", label: "Executive Room", defaultBeds: "1 KING", capacity: 2 },
  { code: "SUITE", label: "Suite", defaultBeds: "1 KING + LIVING", capacity: 2 },
  { code: "FAMILY", label: "Family Room", defaultBeds: "1 KING + 2 SINGLES", capacity: 4 },
  { code: "APARTMENT", label: "Apartment", defaultBeds: "1 KING + 2 SINGLES", capacity: 4 },
  { code: "VILLA", label: "Villa", defaultBeds: "MULTIPLE BEDROOMS", capacity: 6 },
  { code: "CHALET", label: "Chalet", defaultBeds: "1 KING + LIVING", capacity: 3 },
  { code: "TWIN", label: "Twin Room", defaultBeds: "2 SINGLES", capacity: 2 },
  { code: "KING", label: "King Room", defaultBeds: "1 KING", capacity: 2 },
  { code: "QUEEN", label: "Queen Room", defaultBeds: "1 QUEEN", capacity: 2 },
  { code: "STUDIO", label: "Studio", defaultBeds: "1 QUEEN + KITCHENETTE", capacity: 2 },
  { code: "DORMITORY", label: "Dormitory Bed", defaultBeds: "1 SINGLE", capacity: 1 },
  { code: "CUSTOM", label: "Custom", defaultBeds: "", capacity: 2 }
];

export function findRoomTypePreset(code: string | undefined | null): {
  code: string;
  label: string;
  defaultBeds: string;
  capacity: number;
} | null {
  const target = String(code ?? "").trim().toUpperCase();
  if (!target) return null;
  return STANDARD_ROOM_TYPE_PRESETS.find((preset) => preset.code === target) ?? null;
}
