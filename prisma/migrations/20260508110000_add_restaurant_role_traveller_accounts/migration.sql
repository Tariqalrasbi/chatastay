-- Add public traveller accounts for website guests. SQLite stores Prisma enums as TEXT,
-- so adding UserRole.RESTAURANT only changes Prisma schema/client validation.
CREATE TABLE "TravellerAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guestId" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT,
    "phoneE164" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TravellerAccount_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TravellerAccount_email_key" ON "TravellerAccount"("email");
CREATE INDEX "TravellerAccount_guestId_idx" ON "TravellerAccount"("guestId");
