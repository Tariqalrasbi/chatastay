-- Phase D: marketplace foundation.
-- Adds nullable marketing fields to Hotel / Property / RoomType so marketplace surfaces
-- (`/`, `/search`, `/h/:slug`) can render rich hotel cards without breaking any existing
-- single-tenant flow.
--
-- Plan gains supportsMarketplace boolean (default false) so plans can opt-in to public
-- marketplace exposure independently of feature flags. Existing plans retain false until
-- explicitly toggled in /owner/plans.

-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN "amenitiesJson" TEXT;
ALTER TABLE "Hotel" ADD COLUMN "coverImageUrl" TEXT;
ALTER TABLE "Hotel" ADD COLUMN "description" TEXT;
ALTER TABLE "Hotel" ADD COLUMN "latitude" REAL;
ALTER TABLE "Hotel" ADD COLUMN "longitude" REAL;
ALTER TABLE "Hotel" ADD COLUMN "photoUrlsJson" TEXT;
ALTER TABLE "Hotel" ADD COLUMN "starRating" REAL;

-- AlterTable
ALTER TABLE "Property" ADD COLUMN "amenitiesJson" TEXT;
ALTER TABLE "Property" ADD COLUMN "coverImageUrl" TEXT;
ALTER TABLE "Property" ADD COLUMN "description" TEXT;
ALTER TABLE "Property" ADD COLUMN "latitude" REAL;
ALTER TABLE "Property" ADD COLUMN "longitude" REAL;
ALTER TABLE "Property" ADD COLUMN "photoUrlsJson" TEXT;

-- AlterTable
ALTER TABLE "RoomType" ADD COLUMN "bedConfig" TEXT;
ALTER TABLE "RoomType" ADD COLUMN "description" TEXT;
ALTER TABLE "RoomType" ADD COLUMN "photoUrlsJson" TEXT;

-- RedefineTables: add supportsMarketplace to Plan (default false) without dropping data.
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
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Plan" ("billingCycle", "code", "createdAt", "description", "id", "isActive", "maxMonthlyConversations", "maxProperties", "maxRoomTypes", "monthlyPrice", "name", "supportsAiAutomation", "supportsChannelManager", "supportsCustomBranding", "updatedAt") SELECT "billingCycle", "code", "createdAt", "description", "id", "isActive", "maxMonthlyConversations", "maxProperties", "maxRoomTypes", "monthlyPrice", "name", "supportsAiAutomation", "supportsChannelManager", "supportsCustomBranding", "updatedAt" FROM "Plan";
DROP TABLE "Plan";
ALTER TABLE "new_Plan" RENAME TO "Plan";
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
