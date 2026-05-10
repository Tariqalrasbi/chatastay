-- Hotel: brand assets + hotel type captured during onboarding wizard.
ALTER TABLE "Hotel" ADD COLUMN "logoUrl" TEXT;
ALTER TABLE "Hotel" ADD COLUMN "brandPrimaryColor" TEXT;
ALTER TABLE "Hotel" ADD COLUMN "googleMapsUrl" TEXT;
ALTER TABLE "Hotel" ADD COLUMN "hotelType" TEXT;

-- RoomType: occupancy / pricing extensions used by the new room setup step.
ALTER TABLE "RoomType" ADD COLUMN "maxAdults" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "RoomType" ADD COLUMN "maxChildren" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RoomType" ADD COLUMN "roomSizeSqm" REAL;
ALTER TABLE "RoomType" ADD COLUMN "smokingAllowed" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "RoomType" ADD COLUMN "extraBedAvailable" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "RoomType" ADD COLUMN "extraBedRate" REAL;
ALTER TABLE "RoomType" ADD COLUMN "lowSeasonRate" REAL;
ALTER TABLE "RoomType" ADD COLUMN "highSeasonRate" REAL;
ALTER TABLE "RoomType" ADD COLUMN "breakfastIncludedRate" REAL;
ALTER TABLE "RoomType" ADD COLUMN "halfBoardSurcharge" REAL;
ALTER TABLE "RoomType" ADD COLUMN "fullBoardSurcharge" REAL;
ALTER TABLE "RoomType" ADD COLUMN "cancellationRule" TEXT;

-- RoomUnit: optional floor / building captured during onboarding.
ALTER TABLE "RoomUnit" ADD COLUMN "floor" TEXT;
ALTER TABLE "RoomUnit" ADD COLUMN "building" TEXT;

-- SeasonalRate: nightly rate per room type for a date window.
CREATE TABLE "SeasonalRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "nightlyRate" REAL NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SeasonalRate_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SeasonalRate_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SeasonalRate_hotelId_roomTypeId_idx" ON "SeasonalRate"("hotelId", "roomTypeId");
CREATE INDEX "SeasonalRate_hotelId_startDate_endDate_idx" ON "SeasonalRate"("hotelId", "startDate", "endDate");

-- MealPlanOption: per-property meal plan availability + pricing.
CREATE TABLE "MealPlanOption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT 1,
    "pricePerPerson" REAL,
    "pricePerRoom" REAL,
    "serviceWindow" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealPlanOption_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MealPlanOption_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MealPlanOption_hotelId_propertyId_code_key" ON "MealPlanOption"("hotelId", "propertyId", "code");

-- OnboardingDraft: server-side resume support for the multi-step partner wizard.
CREATE TABLE "OnboardingDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "planCode" TEXT NOT NULL DEFAULT 'growth',
    "ownerEmail" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "lastStep" INTEGER NOT NULL DEFAULT 1,
    "completedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "OnboardingDraft_token_key" ON "OnboardingDraft"("token");
CREATE INDEX "OnboardingDraft_expiresAt_idx" ON "OnboardingDraft"("expiresAt");
