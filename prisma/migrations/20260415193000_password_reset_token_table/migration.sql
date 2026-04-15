-- Migration-safe additive auth table for email password reset
-- Uses IF NOT EXISTS to be resilient across environments where db push may already have applied schema.

CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "hotelUserId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "usedAt" DATETIME,
  "requestedIp" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetToken_hotelUserId_fkey"
    FOREIGN KEY ("hotelUserId") REFERENCES "HotelUser" ("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_hotelUserId_createdAt_idx" ON "PasswordResetToken"("hotelUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
