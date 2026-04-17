-- BookingGroup: multi-room / linked bookings under one payer account (optional).
-- Booking: optional bookingGroupId + isPrimaryPayer flag.

CREATE TABLE "BookingGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookingGroup_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "BookingGroup_hotelId_createdAt_idx" ON "BookingGroup"("hotelId", "createdAt");

ALTER TABLE "Booking" ADD COLUMN "bookingGroupId" TEXT REFERENCES "BookingGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD COLUMN "isPrimaryPayer" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Booking_hotelId_bookingGroupId_idx" ON "Booking"("hotelId", "bookingGroupId");
