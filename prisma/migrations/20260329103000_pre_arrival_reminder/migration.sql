-- Pre-arrival WhatsApp reminder tracking (one successful send per booking).
ALTER TABLE "Booking" ADD COLUMN "preArrivalReminderSentAt" DATETIME;
