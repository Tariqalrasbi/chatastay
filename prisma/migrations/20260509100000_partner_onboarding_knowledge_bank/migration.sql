-- Subscription partner onboarding + knowledge bank foundation.
-- Additive migration: existing hotels continue to work and can be backfilled into
-- the new tenant-scoped knowledge structures gradually.

ALTER TABLE "Plan" ADD COLUMN "maxRoomUnits" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Plan" ADD COLUMN "maxStaffUsers" INTEGER NOT NULL DEFAULT 8;

CREATE TABLE "PropertyKnowledgeEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "hotelId" TEXT NOT NULL,
  "propertyId" TEXT,
  "category" TEXT NOT NULL,
  "question" TEXT,
  "answer" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'en',
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT,
  "updatedById" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PropertyKnowledgeEntry_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PropertyKnowledgeEntry_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PropertyKnowledgeEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "PropertyKnowledgeEntry_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "PropertyKnowledgeEntry_hotelId_propertyId_category_locale_idx"
  ON "PropertyKnowledgeEntry"("hotelId", "propertyId", "category", "locale");
CREATE INDEX "PropertyKnowledgeEntry_hotelId_isActive_updatedAt_idx"
  ON "PropertyKnowledgeEntry"("hotelId", "isActive", "updatedAt");

CREATE TABLE "PropertyPolicy" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "hotelId" TEXT NOT NULL,
  "propertyId" TEXT,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'en',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PropertyPolicy_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PropertyPolicy_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PropertyPolicy_hotelId_propertyId_type_locale_idx"
  ON "PropertyPolicy"("hotelId", "propertyId", "type", "locale");
CREATE INDEX "PropertyPolicy_hotelId_isActive_updatedAt_idx"
  ON "PropertyPolicy"("hotelId", "isActive", "updatedAt");

CREATE TABLE "PropertyOnboardingProgress" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "hotelId" TEXT NOT NULL,
  "currentStep" TEXT NOT NULL DEFAULT 'BASIC_INFO',
  "completedSteps" TEXT NOT NULL DEFAULT '[]',
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PropertyOnboardingProgress_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PropertyOnboardingProgress_hotelId_key"
  ON "PropertyOnboardingProgress"("hotelId");
