-- CreateTable
CREATE TABLE "HousekeepingTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "roomUnitId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL,
    "bookingId" TEXT,
    "assignedToUserId" TEXT,
    "createdByUserId" TEXT,
    "completedByUserId" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HousekeepingTask_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HousekeepingTask_roomUnitId_fkey" FOREIGN KEY ("roomUnitId") REFERENCES "RoomUnit" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HousekeepingTask_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "HousekeepingTask_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "HousekeepingTask_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "HousekeepingTask_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "HousekeepingTask_hotelId_status_idx" ON "HousekeepingTask"("hotelId", "status");
CREATE INDEX "HousekeepingTask_hotelId_roomUnitId_idx" ON "HousekeepingTask"("hotelId", "roomUnitId");
CREATE INDEX "HousekeepingTask_assignedToUserId_idx" ON "HousekeepingTask"("assignedToUserId");
