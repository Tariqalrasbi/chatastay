-- HotelUser: columns for in-row password reset + last login (see schema.prisma).
-- These were added to the Prisma model without an earlier migration; production DBs
-- that stopped at housekeeping_login_role (or equivalent) are missing them, which
-- breaks Prisma queries/upserts that RETURN or reference the full model.

ALTER TABLE "HotelUser" ADD COLUMN "passwordResetTokenHash" TEXT;
ALTER TABLE "HotelUser" ADD COLUMN "passwordResetExpiresAt" DATETIME;
ALTER TABLE "HotelUser" ADD COLUMN "passwordResetRequestedAt" DATETIME;
ALTER TABLE "HotelUser" ADD COLUMN "lastLoginAt" DATETIME;
