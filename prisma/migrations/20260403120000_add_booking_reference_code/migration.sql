-- Redefine SQLite enums as TEXT (Prisma): new ChannelProvider values PHONE, CORPORATE, REFERRAL
-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "referenceCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Booking_hotelId_referenceCode_key" ON "Booking"("hotelId", "referenceCode");

-- CreateIndex
CREATE INDEX "Booking_hotelId_referenceCode_idx" ON "Booking"("hotelId", "referenceCode");
