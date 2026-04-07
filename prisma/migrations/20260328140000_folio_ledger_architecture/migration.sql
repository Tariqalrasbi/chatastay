-- Folio container + outlet catalog + payment allocations + extended FolioTransaction (SQLite-safe rebuild).
-- Does not modify unrelated drifted tables.
-- Single-run: re-executing will fail on CREATE TABLE. Order: Folio/Outlet tables → rebuild FolioTransaction → PaymentAllocation → backfill Folio rows → link folioId.

CREATE TABLE "Folio" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "guestId" TEXT,
    "roomUnitId" TEXT,
    "folioCode" TEXT NOT NULL DEFAULT 'MAIN',
    "folioStatus" TEXT NOT NULL DEFAULT 'OPEN',
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Folio_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Folio_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Folio_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Folio_roomUnitId_fkey" FOREIGN KEY ("roomUnitId") REFERENCES "RoomUnit" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Folio_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "Outlet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "outletType" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Outlet_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "OutletMenuItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "unitPrice" REAL NOT NULL,
    "taxRate" REAL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutletMenuItem_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutletMenuItem_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_FolioTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "folioId" TEXT,
    "bookingId" TEXT,
    "guestId" TEXT,
    "roomUnitId" TEXT,
    "roomTypeId" TEXT,
    "transactionType" TEXT NOT NULL,
    "ledgerKind" TEXT,
    "revenueCategory" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'ADMIN_PANEL',
    "outletCategory" TEXT NOT NULL,
    "outletId" TEXT,
    "outletMenuItemId" TEXT,
    "menuItemId" TEXT,
    "itemCode" TEXT,
    "itemName" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" REAL NOT NULL,
    "grossAmount" REAL NOT NULL,
    "discountAmount" REAL NOT NULL DEFAULT 0,
    "taxAmount" REAL NOT NULL DEFAULT 0,
    "netAmount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "postingTarget" TEXT NOT NULL DEFAULT 'BOOKING_ACCOUNT',
    "folioPaymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "folioPaymentMethod" TEXT,
    "referenceNumber" TEXT,
    "chargeDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "serviceDate" DATETIME,
    "postedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveDate" DATETIME,
    "notes" TEXT,
    "staffNote" TEXT,
    "internalNote" TEXT,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "voidedAt" DATETIME,
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "isVoided" BOOLEAN NOT NULL DEFAULT false,
    "parentTransactionId" TEXT,
    "externalSourceId" TEXT,
    "externalSourcePayload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FolioTransaction_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "Folio" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_roomUnitId_fkey" FOREIGN KEY ("roomUnitId") REFERENCES "RoomUnit" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_outletMenuItemId_fkey" FOREIGN KEY ("outletMenuItemId") REFERENCES "OutletMenuItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FolioTransaction_parentTransactionId_fkey" FOREIGN KEY ("parentTransactionId") REFERENCES "FolioTransaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_FolioTransaction" (
    "id", "hotelId", "bookingId", "guestId", "roomUnitId", "roomTypeId",
    "transactionType", "outletCategory", "menuItemId", "itemCode", "itemName", "description",
    "quantity", "unitPrice", "grossAmount", "taxAmount", "netAmount", "currency",
    "postingTarget", "folioPaymentStatus", "folioPaymentMethod", "referenceNumber",
    "chargeDate", "serviceDate", "notes", "createdByUserId", "voidedAt", "voidedByUserId", "voidReason",
    "createdAt", "updatedAt",
    "sourceType", "discountAmount", "postedAt", "isVoided"
)
SELECT
    "id", "hotelId", "bookingId", "guestId", "roomUnitId", "roomTypeId",
    "transactionType", "outletCategory", "menuItemId", "itemCode", "itemName", "description",
    "quantity", "unitPrice", "grossAmount", "taxAmount", "netAmount", "currency",
    "postingTarget", "folioPaymentStatus", "folioPaymentMethod", "referenceNumber",
    "chargeDate", "serviceDate", "notes", "createdByUserId", "voidedAt", "voidedByUserId", "voidReason",
    "createdAt", "updatedAt",
    'ADMIN_PANEL', 0, "createdAt", CASE WHEN "voidedAt" IS NOT NULL THEN 1 ELSE 0 END
FROM "FolioTransaction";

DROP TABLE "FolioTransaction";
ALTER TABLE "new_FolioTransaction" RENAME TO "FolioTransaction";

CREATE INDEX "FolioTransaction_hotelId_bookingId_idx" ON "FolioTransaction"("hotelId", "bookingId");
CREATE INDEX "FolioTransaction_hotelId_folioId_idx" ON "FolioTransaction"("hotelId", "folioId");
CREATE INDEX "FolioTransaction_hotelId_folioId_chargeDate_idx" ON "FolioTransaction"("hotelId", "folioId", "chargeDate");
CREATE INDEX "FolioTransaction_hotelId_roomUnitId_chargeDate_idx" ON "FolioTransaction"("hotelId", "roomUnitId", "chargeDate");
CREATE INDEX "FolioTransaction_bookingId_folioPaymentStatus_idx" ON "FolioTransaction"("bookingId", "folioPaymentStatus");
CREATE INDEX "FolioTransaction_hotelId_ledgerKind_idx" ON "FolioTransaction"("hotelId", "ledgerKind");
CREATE INDEX "FolioTransaction_hotelId_revenueCategory_idx" ON "FolioTransaction"("hotelId", "revenueCategory");
CREATE INDEX "FolioTransaction_hotelId_sourceType_idx" ON "FolioTransaction"("hotelId", "sourceType");
CREATE INDEX "FolioTransaction_hotelId_isVoided_idx" ON "FolioTransaction"("hotelId", "isVoided");
CREATE INDEX "FolioTransaction_hotelId_chargeDate_idx" ON "FolioTransaction"("hotelId", "chargeDate");
CREATE INDEX "FolioTransaction_parentTransactionId_idx" ON "FolioTransaction"("parentTransactionId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "appliedToTransactionId" TEXT,
    "amountApplied" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentAllocation_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaymentAllocation_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "Folio" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaymentAllocation_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "FolioTransaction" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentAllocation_appliedToTransactionId_fkey" FOREIGN KEY ("appliedToTransactionId") REFERENCES "FolioTransaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "Folio_hotelId_bookingId_idx" ON "Folio"("hotelId", "bookingId");
CREATE INDEX "Folio_hotelId_folioStatus_idx" ON "Folio"("hotelId", "folioStatus");
CREATE UNIQUE INDEX "Folio_bookingId_folioCode_key" ON "Folio"("bookingId", "folioCode");

CREATE INDEX "Outlet_hotelId_outletType_isActive_idx" ON "Outlet"("hotelId", "outletType", "isActive");
CREATE UNIQUE INDEX "Outlet_hotelId_code_key" ON "Outlet"("hotelId", "code");

CREATE INDEX "OutletMenuItem_hotelId_outletId_isActive_idx" ON "OutletMenuItem"("hotelId", "outletId", "isActive");
CREATE INDEX "OutletMenuItem_hotelId_itemCode_idx" ON "OutletMenuItem"("hotelId", "itemCode");

CREATE INDEX "PaymentAllocation_hotelId_folioId_idx" ON "PaymentAllocation"("hotelId", "folioId");
CREATE INDEX "PaymentAllocation_paymentTransactionId_idx" ON "PaymentAllocation"("paymentTransactionId");
CREATE INDEX "PaymentAllocation_appliedToTransactionId_idx" ON "PaymentAllocation"("appliedToTransactionId");

-- Default MAIN folio per existing booking (deterministic id for backfill).
INSERT OR IGNORE INTO "Folio" ("id", "hotelId", "bookingId", "guestId", "roomUnitId", "folioCode", "folioStatus", "currency", "openedAt", "createdAt", "updatedAt")
SELECT
    'folio-main-' || "id",
    "hotelId",
    "id",
    "guestId",
    "roomUnitId",
    'MAIN',
    'OPEN',
    "currency",
    "createdAt",
    datetime('now'),
    datetime('now')
FROM "Booking";

UPDATE "FolioTransaction"
SET "folioId" = 'folio-main-' || "bookingId"
WHERE "bookingId" IS NOT NULL;

UPDATE "FolioTransaction" SET "ledgerKind" = 'FNB_CHARGE' WHERE "transactionType" = 'FNB_CHARGE';
UPDATE "FolioTransaction" SET "ledgerKind" = 'ACTIVITY_CHARGE' WHERE "transactionType" = 'ACTIVITY_CHARGE';
UPDATE "FolioTransaction" SET "ledgerKind" = 'SERVICE_CHARGE' WHERE "transactionType" = 'OTHER_SERVICE_CHARGE';
UPDATE "FolioTransaction" SET "ledgerKind" = 'PAYMENT' WHERE "transactionType" = 'PAYMENT';
UPDATE "FolioTransaction" SET "ledgerKind" = 'ADJUSTMENT' WHERE "transactionType" = 'ADJUSTMENT';
UPDATE "FolioTransaction" SET "ledgerKind" = 'REFUND' WHERE "transactionType" = 'REFUND';
UPDATE "FolioTransaction" SET "ledgerKind" = 'DISCOUNT' WHERE "transactionType" = 'DISCOUNT';

UPDATE "FolioTransaction" SET "revenueCategory" = 'RESTAURANT' WHERE "outletCategory" = 'RESTAURANT';
UPDATE "FolioTransaction" SET "revenueCategory" = 'CAFE' WHERE "outletCategory" = 'CAFE';
UPDATE "FolioTransaction" SET "revenueCategory" = 'ACTIVITY' WHERE "outletCategory" = 'ACTIVITY';
UPDATE "FolioTransaction" SET "revenueCategory" = 'ROOM_SERVICE' WHERE "outletCategory" = 'ROOM_SERVICE';
UPDATE "FolioTransaction" SET "revenueCategory" = 'OTHER' WHERE "outletCategory" = 'OTHER';
