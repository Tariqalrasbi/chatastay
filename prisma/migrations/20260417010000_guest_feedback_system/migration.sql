-- Guest feedback: structured post-stay ratings captured from WhatsApp.

CREATE TABLE "GuestFeedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "guestId" TEXT,
    "guestName" TEXT,
    "rating" INTEGER NOT NULL,
    "category" TEXT,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_COMMENT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GuestFeedback_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuestFeedback_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuestFeedback_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE "Booking" ADD COLUMN "guestJourneyReviewReminderSentAt" DATETIME;

CREATE INDEX "GuestFeedback_hotelId_createdAt_idx" ON "GuestFeedback"("hotelId", "createdAt");
CREATE INDEX "GuestFeedback_hotelId_bookingId_idx" ON "GuestFeedback"("hotelId", "bookingId");
CREATE INDEX "GuestFeedback_hotelId_rating_idx" ON "GuestFeedback"("hotelId", "rating");
