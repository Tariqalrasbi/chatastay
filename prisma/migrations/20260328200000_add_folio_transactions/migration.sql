-- CreateTable
CREATE TABLE "FolioTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "bookingId" TEXT,
    "guestId" TEXT,
    "roomUnitId" TEXT,
    "roomTypeId" TEXT,
    "transactionType" TEXT NOT NULL,
    "outletCategory" TEXT NOT NULL,
    "menuItemId" TEXT,
    "itemCode" TEXT,
    "itemName" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" REAL NOT NULL,
    "grossAmount" REAL NOT NULL,
    "taxAmount" REAL NOT NULL DEFAULT 0,
    "netAmount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "postingTarget" TEXT NOT NULL DEFAULT 'BOOKING_ACCOUNT',
    "folioPaymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "folioPaymentMethod" TEXT,
    "referenceNumber" TEXT,
    "chargeDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "serviceDate" DATETIME,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "voidedAt" DATETIME,
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FolioTransaction_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_roomUnitId_fkey" FOREIGN KEY ("roomUnitId") REFERENCES "RoomUnit" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FolioTransaction_hotelId_bookingId_idx" ON "FolioTransaction"("hotelId", "bookingId");

-- CreateIndex
CREATE INDEX "FolioTransaction_hotelId_roomUnitId_chargeDate_idx" ON "FolioTransaction"("hotelId", "roomUnitId", "chargeDate");

-- CreateIndex
CREATE INDEX "FolioTransaction_bookingId_folioPaymentStatus_idx" ON "FolioTransaction"("bookingId", "folioPaymentStatus");
