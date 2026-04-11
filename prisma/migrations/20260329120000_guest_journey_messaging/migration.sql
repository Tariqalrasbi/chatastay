-- Automated guest journey WhatsApp (24h pre-arrival, check-in day, post-checkout thank-you).
ALTER TABLE "Booking" ADD COLUMN "guestJourneyPreArrival24hSentAt" DATETIME;
ALTER TABLE "Booking" ADD COLUMN "guestJourneyCheckinDaySentAt" DATETIME;
ALTER TABLE "Booking" ADD COLUMN "guestJourneyPostCheckoutThankYouSentAt" DATETIME;
