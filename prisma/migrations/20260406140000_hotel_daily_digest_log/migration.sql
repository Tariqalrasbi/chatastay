-- CreateTable
CREATE TABLE "HotelDailyDigestLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "digestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "recipientsCsv" TEXT,
    "subject" TEXT,
    "errorMessage" TEXT,
    "summaryJson" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HotelDailyDigestLog_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "HotelDailyDigestLog_hotelId_digestKey_key" ON "HotelDailyDigestLog"("hotelId", "digestKey");
