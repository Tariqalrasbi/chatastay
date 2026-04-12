-- Front-desk shift close / cashier reconciliation
CREATE TABLE "FrontDeskShift" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "shiftStart" DATETIME NOT NULL,
    "shiftEnd" DATETIME NOT NULL,
    "closedAt" DATETIME NOT NULL,
    "closedByUserId" TEXT,
    "openingCash" REAL NOT NULL,
    "closingCashActual" REAL NOT NULL,
    "bankDepositAmount" REAL NOT NULL DEFAULT 0,
    "expectedClosingCash" REAL NOT NULL,
    "cashVariance" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "status" TEXT NOT NULL DEFAULT 'CLOSED',
    "locked" INTEGER NOT NULL DEFAULT 1,
    "snapshotJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FrontDeskShift_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FrontDeskShift_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "FrontDeskShift_hotelId_closedAt_idx" ON "FrontDeskShift"("hotelId", "closedAt");
CREATE INDEX "FrontDeskShift_hotelId_shiftStart_idx" ON "FrontDeskShift"("hotelId", "shiftStart");

CREATE TABLE "FrontDeskShiftExpense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shiftId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FrontDeskShiftExpense_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "FrontDeskShift" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
