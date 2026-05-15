-- AlterTable
ALTER TABLE "Guest" ADD COLUMN "phoneCountryCode" TEXT;
ALTER TABLE "Guest" ADD COLUMN "phoneNationalNumber" TEXT;
ALTER TABLE "Guest" ADD COLUMN "phoneRaw" TEXT;

-- CreateIndex
CREATE INDEX "Guest_hotelId_phoneCountryCode_idx" ON "Guest"("hotelId", "phoneCountryCode");
