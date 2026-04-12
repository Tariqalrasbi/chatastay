-- Multi-shift, cashier handover, printable report metadata (additive)
ALTER TABLE "FrontDeskShift" ADD COLUMN "shiftSlot" TEXT NOT NULL DEFAULT 'CUSTOM';
ALTER TABLE "FrontDeskShift" ADD COLUMN "shiftLabel" TEXT;
ALTER TABLE "FrontDeskShift" ADD COLUMN "businessDate" TEXT NOT NULL DEFAULT '1970-01-01';
ALTER TABLE "FrontDeskShift" ADD COLUMN "openingCashSource" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "FrontDeskShift" ADD COLUMN "priorShiftId" TEXT;
ALTER TABLE "FrontDeskShift" ADD COLUMN "handoverNote" TEXT;

UPDATE "FrontDeskShift" SET "businessDate" = date("shiftStart") WHERE "businessDate" = '1970-01-01';

CREATE INDEX "FrontDeskShift_hotelId_businessDate_idx" ON "FrontDeskShift"("hotelId", "businessDate");
