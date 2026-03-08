-- CreateTable
CREATE TABLE "ConversationSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "conversationId" TEXT,
    "phoneE164" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "stage" TEXT NOT NULL DEFAULT 'IDLE',
    "metadataJson" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConversationSession_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConversationSession_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConversationSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BookingDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "conversationId" TEXT,
    "bookingId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "checkIn" DATETIME,
    "checkOut" DATETIME,
    "adults" INTEGER NOT NULL DEFAULT 2,
    "rooms" INTEGER NOT NULL DEFAULT 1,
    "guestName" TEXT,
    "roomTypeId" TEXT,
    "roomTypeName" TEXT,
    "propertyId" TEXT,
    "nightlyRate" REAL,
    "totalAmount" REAL,
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "metadataJson" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookingDraft_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookingDraft_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookingDraft_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BookingDraft_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CalendarSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "guestId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "intentSource" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "metadataJson" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CalendarSession_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CalendarSession_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ConversationSession_hotelId_stage_idx" ON "ConversationSession"("hotelId", "stage");

-- CreateIndex
CREATE INDEX "ConversationSession_hotelId_phoneE164_idx" ON "ConversationSession"("hotelId", "phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationSession_hotelId_guestId_key" ON "ConversationSession"("hotelId", "guestId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingDraft_bookingId_key" ON "BookingDraft"("bookingId");

-- CreateIndex
CREATE INDEX "BookingDraft_hotelId_guestId_status_idx" ON "BookingDraft"("hotelId", "guestId", "status");

-- CreateIndex
CREATE INDEX "BookingDraft_hotelId_checkIn_checkOut_idx" ON "BookingDraft"("hotelId", "checkIn", "checkOut");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarSession_tokenHash_key" ON "CalendarSession"("tokenHash");

-- CreateIndex
CREATE INDEX "CalendarSession_hotelId_expiresAt_idx" ON "CalendarSession"("hotelId", "expiresAt");

-- CreateIndex
CREATE INDEX "CalendarSession_hotelId_phoneE164_idx" ON "CalendarSession"("hotelId", "phoneE164");
