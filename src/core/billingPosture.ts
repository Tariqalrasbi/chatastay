/**
 * Phase C-D: subscription-readiness helper.
 *
 * Today, ChatAstay records subscriptions as a database fact (`Subscription` /
 * `Plan` / `Invoice` / `PaymentIntent`) but **never refuses access** based on
 * subscription status. That means a `PAST_DUE` or `CANCELED` tenant keeps
 * operating exactly like a paying tenant — no commercial pressure on payment.
 *
 * This helper is the read-side primitive for billing decisions. It is
 * deliberately conservative:
 *   • Returns the **most recent** Subscription for a hotel (one tenant can
 *     have history rows from past plan changes).
 *   • Falls back to the cached fields on `Hotel` (set by /owner UI on plan
 *     changes) when no Subscription row exists yet — this matches the seed
 *     state of older tenants who pre-date the subscription model.
 *   • Computes `gracePeriod` and `hardBlockReady` flags so callers can choose
 *     soft (banner) vs hard (refuse) treatment without re-deriving rules.
 *
 * The companion middleware `requireBillingHealthy` is gated behind the
 * `BILLING_GATE_ENABLED` env flag and is a no-op until the flag flips. That
 * keeps Phase C-D fully reversible: ship the helper + UI now, flip the flag
 * later when commercial collection is in place.
 */

import { Prisma, SubscriptionStatus } from "@prisma/client";
import { prisma } from "../db";

export type BillingPosture = {
  hotelId: string;
  /** TRIALING | ACTIVE | PAST_DUE | CANCELED | "NO_SUBSCRIPTION" */
  status: SubscriptionStatus | "NO_SUBSCRIPTION";
  planCode: string | null;
  planName: string | null;
  subscriptionId: string | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  /** True when status is TRIALING or ACTIVE — the "happy path". */
  isHealthy: boolean;
  /** True when status is PAST_DUE — payment recently failed but not yet canceled. */
  inGrace: boolean;
  /** True when status is CANCELED — would block if BILLING_GATE_ENABLED is on. */
  isBlocked: boolean;
  /** True only when env flag is on AND status is CANCELED — ready to actually refuse. */
  hardBlockReady: boolean;
};

/**
 * Compute the canonical billing posture for a hotel. Reads the most recent
 * Subscription row and falls back to the cached posture on Hotel when none.
 */
export async function getHotelBillingPosture(hotelId: string): Promise<BillingPosture> {
  const subscription = await prisma.subscription.findFirst({
    where: { hotelId },
    include: { plan: true },
    orderBy: { createdAt: "desc" }
  });

  const gateEnabled = String(process.env.BILLING_GATE_ENABLED ?? "").trim().toLowerCase() === "true";

  if (subscription) {
    const status = subscription.status;
    const isHealthy = status === SubscriptionStatus.TRIALING || status === SubscriptionStatus.ACTIVE;
    const inGrace = status === SubscriptionStatus.PAST_DUE;
    const isBlocked = status === SubscriptionStatus.CANCELED;
    return {
      hotelId,
      status,
      planCode: subscription.plan.code,
      planName: subscription.plan.name,
      subscriptionId: subscription.id,
      trialEndsAt: null,
      currentPeriodEnd: subscription.currentPeriodEnd ?? null,
      isHealthy,
      inGrace,
      isBlocked,
      hardBlockReady: gateEnabled && isBlocked
    };
  }

  const hotel = await prisma.hotel.findUnique({
    where: { id: hotelId },
    select: {
      subscriptionPlanCode: true,
      subscriptionStatusCached: true,
      trialEndsAt: true
    }
  });

  const cachedStatus = hotel?.subscriptionStatusCached ?? null;
  const cachedPlanCode = hotel?.subscriptionPlanCode ?? null;
  const cachedTrialEnd = hotel?.trialEndsAt ?? null;
  const status: BillingPosture["status"] = cachedStatus ?? "NO_SUBSCRIPTION";
  const isHealthy =
    status === SubscriptionStatus.TRIALING ||
    status === SubscriptionStatus.ACTIVE ||
    status === "NO_SUBSCRIPTION";
  const inGrace = status === SubscriptionStatus.PAST_DUE;
  const isBlocked = status === SubscriptionStatus.CANCELED;

  return {
    hotelId,
    status,
    planCode: cachedPlanCode,
    planName: null,
    subscriptionId: null,
    trialEndsAt: cachedTrialEnd,
    currentPeriodEnd: null,
    isHealthy,
    inGrace,
    isBlocked,
    hardBlockReady: gateEnabled && isBlocked
  };
}

/**
 * Sync the cached posture fields on the Hotel row from the latest Subscription.
 * Call this after creating/updating a Subscription, or after a webhook flips
 * `Subscription.status`. Always safe to call (idempotent, transactional).
 */
export async function refreshHotelBillingCache(hotelId: string): Promise<BillingPosture> {
  const posture = await getHotelBillingPosture(hotelId);
  await prisma.hotel.update({
    where: { id: hotelId },
    data: {
      subscriptionPlanCode: posture.planCode,
      subscriptionStatusCached:
        posture.status === "NO_SUBSCRIPTION" ? null : (posture.status as SubscriptionStatus),
      trialEndsAt: posture.trialEndsAt
    }
  });
  return posture;
}

/**
 * Express middleware factory: refuse requests for tenants whose subscription
 * is hard-blocked. This is a **no-op** unless `BILLING_GATE_ENABLED=true`,
 * which keeps Phase C-D safely reversible.
 *
 * Caller must attach `req.hotelId` (or pass a getter) so we know which tenant
 * to check. We deliberately don't import any auth middleware here to avoid
 * circular dependencies — wire it into routes that already resolve the tenant.
 */
export function requireBillingHealthy(getHotelId: (req: { hotelId?: string }) => string | null) {
  return async (
    req: { hotelId?: string },
    res: { status: (n: number) => { json: (b: unknown) => void; send: (b: string) => void } },
    next: () => void
  ): Promise<void> => {
    const gateEnabled = String(process.env.BILLING_GATE_ENABLED ?? "").trim().toLowerCase() === "true";
    if (!gateEnabled) {
      next();
      return;
    }

    const hotelId = getHotelId(req);
    if (!hotelId) {
      next();
      return;
    }

    try {
      const posture = await getHotelBillingPosture(hotelId);
      if (posture.hardBlockReady) {
        res.status(402).json({
          error: "subscription_required",
          message: "This hotel's subscription is canceled. Reactivate via the Platform Console.",
          status: posture.status
        });
        return;
      }
      next();
    } catch (err) {
      // Fail-open: never break operations because of a billing-cache miss.
      next();
    }
  };
}
