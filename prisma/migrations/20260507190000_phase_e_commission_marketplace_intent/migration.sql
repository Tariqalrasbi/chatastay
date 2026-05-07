-- Phase E: marketplace booking flow + commission tracking.
--   * Adds Commission ledger (one row per CHATASTAY_MARKETPLACE booking; written
--     inside the booking transaction so ledger and bookings can never disagree).
--   * Adds MarketplaceBookingIntent (short-lived seed for "Continue on WhatsApp"
--     deep-links; consumed by the WhatsApp webhook to seed a BookingDraft).
--   * Adds Plan.commissionBps (default 0; snapshotted onto each Commission row).
--   * SQLite enums are TEXT-typed; ChannelProvider gains the CHATASTAY_MARKETPLACE
--     value implicitly because Prisma stores enum values as plain strings — no
--     ALTER TYPE needed.

-- CreateTable
CREATE TABLE "Commission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "planId" TEXT,
    "planCodeSnapshot" TEXT,
    "percentBps" INTEGER NOT NULL,
    "amountCalc" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "statusChangedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Commission_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Commission_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Commission_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MarketplaceBookingIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "hotelSlug" TEXT NOT NULL,
    "checkIn" DATETIME,
    "checkOut" DATETIME,
    "guests" INTEGER NOT NULL DEFAULT 2,
    "rooms" INTEGER NOT NULL DEFAULT 1,
    "preferredRoomTypeId" TEXT,
    "claimedByGuestId" TEXT,
    "claimedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketplaceBookingIntent_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables: add commissionBps to Plan.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Plan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "billingCycle" TEXT NOT NULL DEFAULT 'MONTHLY',
    "monthlyPrice" REAL NOT NULL,
    "maxProperties" INTEGER NOT NULL DEFAULT 1,
    "maxRoomTypes" INTEGER NOT NULL DEFAULT 20,
    "maxMonthlyConversations" INTEGER NOT NULL DEFAULT 2000,
    "supportsChannelManager" BOOLEAN NOT NULL DEFAULT false,
    "supportsCustomBranding" BOOLEAN NOT NULL DEFAULT false,
    "supportsAiAutomation" BOOLEAN NOT NULL DEFAULT true,
    "supportsMarketplace" BOOLEAN NOT NULL DEFAULT false,
    "commissionBps" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Plan" ("billingCycle", "code", "createdAt", "description", "id", "isActive", "maxMonthlyConversations", "maxProperties", "maxRoomTypes", "monthlyPrice", "name", "supportsAiAutomation", "supportsChannelManager", "supportsCustomBranding", "supportsMarketplace", "updatedAt") SELECT "billingCycle", "code", "createdAt", "description", "id", "isActive", "maxMonthlyConversations", "maxProperties", "maxRoomTypes", "monthlyPrice", "name", "supportsAiAutomation", "supportsChannelManager", "supportsCustomBranding", "supportsMarketplace", "updatedAt" FROM "Plan";
DROP TABLE "Plan";
ALTER TABLE "new_Plan" RENAME TO "Plan";
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Commission_hotelId_status_createdAt_idx" ON "Commission"("hotelId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Commission_bookingId_idx" ON "Commission"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceBookingIntent_token_key" ON "MarketplaceBookingIntent"("token");

-- CreateIndex
CREATE INDEX "MarketplaceBookingIntent_hotelId_createdAt_idx" ON "MarketplaceBookingIntent"("hotelId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceBookingIntent_expiresAt_idx" ON "MarketplaceBookingIntent"("expiresAt");
