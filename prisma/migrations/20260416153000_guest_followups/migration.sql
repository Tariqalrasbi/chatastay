CREATE TABLE "GuestFollowUp" (
  "id" TEXT NOT NULL,
  "hotelId" TEXT NOT NULL,
  "guestId" TEXT NOT NULL,
  "bookingId" TEXT,
  "conversationId" TEXT,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "dedupeKey" TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "payloadJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GuestFollowUp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuestFollowUp_dedupeKey_key" ON "GuestFollowUp"("dedupeKey");
CREATE INDEX "GuestFollowUp_hotelId_status_scheduledFor_idx" ON "GuestFollowUp"("hotelId", "status", "scheduledFor");
CREATE INDEX "GuestFollowUp_hotelId_guestId_type_idx" ON "GuestFollowUp"("hotelId", "guestId", "type");

ALTER TABLE "GuestFollowUp"
  ADD CONSTRAINT "GuestFollowUp_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GuestFollowUp"
  ADD CONSTRAINT "GuestFollowUp_guestId_fkey"
  FOREIGN KEY ("guestId") REFERENCES "Guest"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GuestFollowUp"
  ADD CONSTRAINT "GuestFollowUp_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GuestFollowUp"
  ADD CONSTRAINT "GuestFollowUp_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
