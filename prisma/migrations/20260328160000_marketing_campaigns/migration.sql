-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purposeNote" TEXT,
    "filtersJson" TEXT NOT NULL,
    "messageBody" TEXT NOT NULL,
    "linkedOfferId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "audienceCount" INTEGER NOT NULL DEFAULT 0,
    "attemptedCount" INTEGER NOT NULL DEFAULT 0,
    "sentOkCount" INTEGER NOT NULL DEFAULT 0,
    "sentFailedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedNoPhoneCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    CONSTRAINT "MarketingCampaign_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MarketingCampaignRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorDetail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketingCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MarketingCampaignRecipient_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MarketingCampaign_hotelId_createdAt_idx" ON "MarketingCampaign"("hotelId", "createdAt");
CREATE UNIQUE INDEX "MarketingCampaignRecipient_campaignId_guestId_key" ON "MarketingCampaignRecipient"("campaignId", "guestId");
CREATE INDEX "MarketingCampaignRecipient_campaignId_idx" ON "MarketingCampaignRecipient"("campaignId");
