-- OutletOrderTicket: internal kitchen/outlet tickets linked to FbOrder or FolioTransaction.

CREATE TABLE "OutletOrderTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "guestId" TEXT,
    "source" TEXT NOT NULL,
    "fbOrderId" TEXT,
    "folioTransactionId" TEXT,
    "outletKey" TEXT NOT NULL,
    "serviceMode" TEXT,
    "notes" TEXT,
    "ticketStatus" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutletOrderTicket_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutletOrderTicket_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutletOrderTicket_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OutletOrderTicket_fbOrderId_fkey" FOREIGN KEY ("fbOrderId") REFERENCES "FbOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutletOrderTicket_folioTransactionId_fkey" FOREIGN KEY ("folioTransactionId") REFERENCES "FolioTransaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OutletOrderTicket_fbOrderId_key" ON "OutletOrderTicket"("fbOrderId");
CREATE UNIQUE INDEX "OutletOrderTicket_folioTransactionId_key" ON "OutletOrderTicket"("folioTransactionId");
CREATE INDEX "OutletOrderTicket_hotelId_ticketStatus_idx" ON "OutletOrderTicket"("hotelId", "ticketStatus");
CREATE INDEX "OutletOrderTicket_hotelId_outletKey_idx" ON "OutletOrderTicket"("hotelId", "outletKey");
CREATE INDEX "OutletOrderTicket_hotelId_createdAt_idx" ON "OutletOrderTicket"("hotelId", "createdAt");
