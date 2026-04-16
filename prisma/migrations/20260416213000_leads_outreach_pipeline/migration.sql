CREATE TABLE "Lead" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "hotelId" TEXT NOT NULL,
  "convertedPropertyId" TEXT,
  "hotelName" TEXT NOT NULL,
  "contactName" TEXT,
  "contactEmail" TEXT,
  "contactPhone" TEXT,
  "location" TEXT,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "status" TEXT NOT NULL DEFAULT 'new',
  "lastContactedAt" DATETIME,
  "notes" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "LeadOutreachLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "hotelId" TEXT NOT NULL,
  "propertyId" TEXT,
  "leadId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "templateKey" TEXT NOT NULL,
  "messageBody" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'SENT',
  "responseStatus" TEXT DEFAULT 'pending',
  "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "Lead_hotelId_status_createdAt_idx" ON "Lead"("hotelId", "status", "createdAt");
CREATE INDEX "Lead_hotelId_contactEmail_idx" ON "Lead"("hotelId", "contactEmail");
CREATE INDEX "Lead_hotelId_contactPhone_idx" ON "Lead"("hotelId", "contactPhone");

CREATE INDEX "LeadOutreachLog_hotelId_leadId_createdAt_idx" ON "LeadOutreachLog"("hotelId", "leadId", "createdAt");
CREATE INDEX "LeadOutreachLog_hotelId_channel_sentAt_idx" ON "LeadOutreachLog"("hotelId", "channel", "sentAt");

ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_convertedPropertyId_fkey"
  FOREIGN KEY ("convertedPropertyId") REFERENCES "Property"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LeadOutreachLog"
  ADD CONSTRAINT "LeadOutreachLog_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeadOutreachLog"
  ADD CONSTRAINT "LeadOutreachLog_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LeadOutreachLog"
  ADD CONSTRAINT "LeadOutreachLog_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
