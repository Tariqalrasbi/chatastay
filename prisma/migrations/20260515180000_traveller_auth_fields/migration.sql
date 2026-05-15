-- Traveller account: email verification, password reset, optional profile fields.
ALTER TABLE "TravellerAccount" ADD COLUMN "nationality" TEXT;
ALTER TABLE "TravellerAccount" ADD COLUMN "preferredLanguage" TEXT;
ALTER TABLE "TravellerAccount" ADD COLUMN "emailVerifiedAt" DATETIME;
ALTER TABLE "TravellerAccount" ADD COLUMN "emailVerificationTokenHash" TEXT;
ALTER TABLE "TravellerAccount" ADD COLUMN "emailVerificationExpiresAt" DATETIME;
ALTER TABLE "TravellerAccount" ADD COLUMN "passwordResetTokenHash" TEXT;
ALTER TABLE "TravellerAccount" ADD COLUMN "passwordResetExpiresAt" DATETIME;
ALTER TABLE "TravellerAccount" ADD COLUMN "passwordResetRequestedAt" DATETIME;

CREATE INDEX "TravellerAccount_emailVerificationTokenHash_idx" ON "TravellerAccount"("emailVerificationTokenHash");
CREATE INDEX "TravellerAccount_passwordResetTokenHash_idx" ON "TravellerAccount"("passwordResetTokenHash");

-- Existing accounts are treated as already verified.
UPDATE "TravellerAccount" SET "emailVerifiedAt" = CURRENT_TIMESTAMP WHERE "emailVerifiedAt" IS NULL;
