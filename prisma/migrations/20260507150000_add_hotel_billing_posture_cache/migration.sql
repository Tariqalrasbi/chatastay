-- Phase C-D: cache the latest subscription posture on the Hotel row so read-side checks
-- (middleware, dashboards, marketplace gating) can avoid a Subscription join on every request.
-- Source-of-truth remains the Subscription / Plan rows; this cache is refreshed by /owner UI
-- on plan changes and by Stripe/Thawani webhooks on status flips.
-- All three fields are nullable for backward-compat with hotels that have no subscription record.

-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN "subscriptionPlanCode" TEXT;
ALTER TABLE "Hotel" ADD COLUMN "subscriptionStatusCached" TEXT;
ALTER TABLE "Hotel" ADD COLUMN "trialEndsAt" DATETIME;
