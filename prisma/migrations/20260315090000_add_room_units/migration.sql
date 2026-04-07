-- CreateTable
CREATE TABLE "RoomUnit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RoomUnit_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoomUnit_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "roomUnitId" TEXT REFERENCES "RoomUnit" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "RoomUnit_roomTypeId_name_key" ON "RoomUnit"("roomTypeId", "name");
CREATE INDEX "RoomUnit_hotelId_roomTypeId_isActive_idx" ON "RoomUnit"("hotelId", "roomTypeId", "isActive");
CREATE INDEX "Booking_roomUnitId_idx" ON "Booking"("roomUnitId");
