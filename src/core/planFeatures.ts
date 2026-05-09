import type { PrismaClient } from "@prisma/client";

export type WhatsAppAutomationLevel = "basic" | "standard" | "advanced" | "enterprise";

export type PlanFeatureSet = {
  code: string;
  label: string;
  maxProperties: number;
  maxRoomTypes: number;
  maxRoomUnits: number;
  maxStaffUsers: number;
  maxMonthlyConversations: number;
  restaurantModule: boolean;
  housekeepingModule: boolean;
  basicReports: boolean;
  advancedReports: boolean;
  aiConcierge: boolean;
  whatsappAutomationLevel: WhatsAppAutomationLevel;
  marketplaceVisibility: boolean;
  customBranding: boolean;
  multiProperty: boolean;
  staffPermissions: boolean;
  travellerLoyalty: boolean;
  apiAccess: boolean;
  channelManager: boolean;
};

export type HotelPlanContext = {
  hotelId: string;
  planCode: string | null;
  planName: string;
  features: PlanFeatureSet;
};

export class PlanLimitError extends Error {
  readonly feature: keyof PlanFeatureSet | string;

  constructor(feature: keyof PlanFeatureSet | string, message: string) {
    super(message);
    this.name = "PlanLimitError";
    this.feature = feature;
  }
}

const DEFAULT_PLAN_CODE = "starter";

const PLAN_DEFAULTS: Record<string, PlanFeatureSet> = {
  starter: {
    code: "starter",
    label: "Starter",
    maxProperties: 1,
    maxRoomTypes: 8,
    maxRoomUnits: 20,
    maxStaffUsers: 5,
    maxMonthlyConversations: 1500,
    restaurantModule: false,
    housekeepingModule: false,
    basicReports: true,
    advancedReports: false,
    aiConcierge: false,
    whatsappAutomationLevel: "basic",
    marketplaceVisibility: false,
    customBranding: false,
    multiProperty: false,
    staffPermissions: false,
    travellerLoyalty: false,
    apiAccess: false,
    channelManager: false
  },
  growth: {
    code: "growth",
    label: "Growth",
    maxProperties: 3,
    maxRoomTypes: 40,
    maxRoomUnits: 120,
    maxStaffUsers: 20,
    maxMonthlyConversations: 8000,
    restaurantModule: true,
    housekeepingModule: true,
    basicReports: true,
    advancedReports: false,
    aiConcierge: false,
    whatsappAutomationLevel: "standard",
    marketplaceVisibility: true,
    customBranding: true,
    multiProperty: true,
    staffPermissions: true,
    travellerLoyalty: false,
    apiAccess: false,
    channelManager: true
  },
  pro: {
    code: "pro",
    label: "Pro",
    maxProperties: 12,
    maxRoomTypes: 200,
    maxRoomUnits: 800,
    maxStaffUsers: 80,
    maxMonthlyConversations: 50000,
    restaurantModule: true,
    housekeepingModule: true,
    basicReports: true,
    advancedReports: true,
    aiConcierge: true,
    whatsappAutomationLevel: "advanced",
    marketplaceVisibility: true,
    customBranding: true,
    multiProperty: true,
    staffPermissions: true,
    travellerLoyalty: true,
    apiAccess: false,
    channelManager: true
  },
  premium: {
    code: "premium",
    label: "Premium",
    maxProperties: 20,
    maxRoomTypes: 400,
    maxRoomUnits: 1600,
    maxStaffUsers: 150,
    maxMonthlyConversations: 100000,
    restaurantModule: true,
    housekeepingModule: true,
    basicReports: true,
    advancedReports: true,
    aiConcierge: true,
    whatsappAutomationLevel: "advanced",
    marketplaceVisibility: true,
    customBranding: true,
    multiProperty: true,
    staffPermissions: true,
    travellerLoyalty: true,
    apiAccess: true,
    channelManager: true
  },
  enterprise: {
    code: "enterprise",
    label: "Enterprise",
    maxProperties: 999,
    maxRoomTypes: 999,
    maxRoomUnits: 9999,
    maxStaffUsers: 999,
    maxMonthlyConversations: 999999,
    restaurantModule: true,
    housekeepingModule: true,
    basicReports: true,
    advancedReports: true,
    aiConcierge: true,
    whatsappAutomationLevel: "enterprise",
    marketplaceVisibility: true,
    customBranding: true,
    multiProperty: true,
    staffPermissions: true,
    travellerLoyalty: true,
    apiAccess: true,
    channelManager: true
  }
};

function normalizePlanCode(code: string | null | undefined): string {
  const normalized = String(code ?? "").trim().toLowerCase();
  return normalized || DEFAULT_PLAN_CODE;
}

export function getPlanFeatures(planCode: string | null | undefined): PlanFeatureSet {
  const code = normalizePlanCode(planCode);
  return PLAN_DEFAULTS[code] ?? { ...PLAN_DEFAULTS[DEFAULT_PLAN_CODE], code };
}

export async function loadHotelPlanContext(
  prisma: PrismaClient,
  hotelId: string
): Promise<HotelPlanContext> {
  const hotel = await prisma.hotel.findUnique({
    where: { id: hotelId },
    select: {
      subscriptionPlanCode: true,
      subscriptions: {
        where: { status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { plan: true }
      }
    }
  });
  const subscription = hotel?.subscriptions[0] ?? null;
  const plan = subscription?.plan ?? null;
  const code = normalizePlanCode(plan?.code ?? hotel?.subscriptionPlanCode ?? null);
  const defaults = getPlanFeatures(code);
  return {
    hotelId,
    planCode: code,
    planName: plan?.name ?? defaults.label,
    features: {
      ...defaults,
      code,
      label: plan?.name ?? defaults.label,
      maxProperties: plan?.maxProperties ?? defaults.maxProperties,
      maxRoomTypes: plan?.maxRoomTypes ?? defaults.maxRoomTypes,
      maxRoomUnits: plan?.maxRoomUnits ?? defaults.maxRoomUnits,
      maxStaffUsers: plan?.maxStaffUsers ?? defaults.maxStaffUsers,
      maxMonthlyConversations: plan?.maxMonthlyConversations ?? defaults.maxMonthlyConversations,
      channelManager: plan?.supportsChannelManager ?? defaults.channelManager,
      customBranding: plan?.supportsCustomBranding ?? defaults.customBranding,
      aiConcierge: plan?.supportsAiAutomation ?? defaults.aiConcierge,
      marketplaceVisibility: plan?.supportsMarketplace ?? defaults.marketplaceVisibility
    }
  };
}

export function canUseFeature(ctx: HotelPlanContext, feature: keyof PlanFeatureSet): boolean {
  return Boolean(ctx.features[feature]);
}

export function assertFeature(ctx: HotelPlanContext, feature: keyof PlanFeatureSet, label?: string): void {
  if (!canUseFeature(ctx, feature)) {
    throw new PlanLimitError(feature, `${label ?? String(feature)} is not included in the ${ctx.planName} plan.`);
  }
}

export function assertWithinLimit(
  ctx: HotelPlanContext,
  limitKey: keyof Pick<PlanFeatureSet, "maxProperties" | "maxRoomTypes" | "maxRoomUnits" | "maxStaffUsers" | "maxMonthlyConversations">,
  requestedTotal: number,
  label: string
): void {
  const limit = Number(ctx.features[limitKey]);
  if (Number.isFinite(limit) && limit >= 0 && requestedTotal > limit) {
    throw new PlanLimitError(limitKey, `${label} limit reached on the ${ctx.planName} plan (${requestedTotal}/${limit}).`);
  }
}

export function upgradeMessage(message: string): string {
  return `${message} Upgrade your ChatAstay plan to unlock this workflow.`;
}
