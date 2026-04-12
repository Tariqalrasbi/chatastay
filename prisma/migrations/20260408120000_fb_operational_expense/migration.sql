-- F&B operational expenses (purchases / supplies), separate from guest folio
CREATE TABLE "FbOperationalExpense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "expenseDate" DATETIME NOT NULL,
    "amount" REAL NOT NULL,
    "category" TEXT NOT NULL,
    "outlet" TEXT,
    "paymentMethod" TEXT,
    "referenceNote" TEXT,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FbOperationalExpense_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FbOperationalExpense_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "FbOperationalExpense_hotelId_expenseDate_idx" ON "FbOperationalExpense"("hotelId", "expenseDate");
