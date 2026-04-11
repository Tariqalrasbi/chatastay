-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "guestJourneyReviewRequestSentAt" DATETIME;
ALTER TABLE "Booking" ADD COLUMN "guestJourneyRepeatPromoSentAt" DATETIME;

-- AlterTable
ALTER TABLE "Guest" ADD COLUMN "journeyLastRepeatPromoAt" DATETIME;
