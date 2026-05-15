-- Partner CRM: optional next follow-up on platform acquisition leads
ALTER TABLE "Lead" ADD COLUMN "nextFollowUpAt" DATETIME;

CREATE INDEX "Lead_hotelId_nextFollowUpAt_idx" ON "Lead"("hotelId", "nextFollowUpAt");
