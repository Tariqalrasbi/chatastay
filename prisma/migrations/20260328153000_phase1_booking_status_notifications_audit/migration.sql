-- AlterTable
ALTER TABLE "Guest" ADD COLUMN "nationality" TEXT;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "bookingId" TEXT;

-- CreateTable
CREATE TABLE "BookingStatusHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'SYSTEM',
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookingStatusHistory_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookingStatusHistory_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookingStatusHistory_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "guestId" TEXT,
    "hotelUserId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'IN_APP',
    "type" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payloadJson" TEXT,
    "readAt" DATETIME,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_hotelUserId_fkey" FOREIGN KEY ("hotelUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BookingStatusHistory_hotelId_bookingId_idx" ON "BookingStatusHistory"("hotelId", "bookingId");

-- CreateIndex
CREATE INDEX "BookingStatusHistory_hotelId_createdAt_idx" ON "BookingStatusHistory"("hotelId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_hotelId_bookingId_idx" ON "AuditLog"("hotelId", "bookingId");

-- CreateIndex
CREATE INDEX "Notification_hotelId_status_idx" ON "Notification"("hotelId", "status");

-- CreateIndex
CREATE INDEX "Notification_hotelId_guestId_idx" ON "Notification"("hotelId", "guestId");

-- CreateIndex
CREATE INDEX "Notification_hotelId_hotelUserId_idx" ON "Notification"("hotelId", "hotelUserId");

-- CreateIndex
CREATE INDEX "Notification_hotelId_createdAt_idx" ON "Notification"("hotelId", "createdAt");
