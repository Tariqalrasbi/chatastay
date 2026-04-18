-- CreateTable
CREATE TABLE "Hotel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "city" TEXT,
    "country" TEXT NOT NULL DEFAULT 'OM',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Muscat',
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "whatsappPhone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

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
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HotelDailyDigestLog_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HotelUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "username" TEXT,
    "pinHash" TEXT,
    "passwordHash" TEXT NOT NULL,
    "passwordResetTokenHash" TEXT,
    "passwordResetExpiresAt" DATETIME,
    "passwordResetRequestedAt" DATETIME,
    "lastLoginAt" DATETIME,
    "role" TEXT NOT NULL DEFAULT 'MANAGER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HotelUser_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "requestedIp" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_hotelUserId_fkey" FOREIGN KEY ("hotelUserId") REFERENCES "HotelUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FrontDeskShift" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "shiftSlot" TEXT NOT NULL DEFAULT 'CUSTOM',
    "shiftLabel" TEXT,
    "businessDate" TEXT NOT NULL DEFAULT '1970-01-01',
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
    "locked" BOOLEAN NOT NULL DEFAULT true,
    "openingCashSource" TEXT NOT NULL DEFAULT 'MANUAL',
    "priorShiftId" TEXT,
    "handoverNote" TEXT,
    "snapshotJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FrontDeskShift_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FrontDeskShift_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FrontDeskShift_priorShiftId_fkey" FOREIGN KEY ("priorShiftId") REFERENCES "FrontDeskShift" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FrontDeskShiftExpense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shiftId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FrontDeskShiftExpense_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "FrontDeskShift" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "addressLine1" TEXT,
    "checkInTime" TEXT,
    "checkOutTime" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Property_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "convertedPropertyId" TEXT,
    "hotelName" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "location" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'new',
    "lastContactedAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Lead_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Lead_convertedPropertyId_fkey" FOREIGN KEY ("convertedPropertyId") REFERENCES "Property" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LeadOutreachLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "propertyId" TEXT,
    "leadId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "messageBody" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "responseStatus" TEXT DEFAULT 'pending',
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadOutreachLog_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LeadOutreachLog_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LeadOutreachLog_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RoomType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 2,
    "baseNightlyRate" REAL NOT NULL,
    "totalInventory" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RoomType_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoomType_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Inventory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "total" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "closedOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Inventory_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Inventory_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Inventory_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Guest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "fullName" TEXT,
    "phoneE164" TEXT NOT NULL,
    "email" TEXT,
    "nationality" TEXT,
    "locale" TEXT DEFAULT 'en',
    "journeyLastRepeatPromoAt" DATETIME,
    "isVip" BOOLEAN NOT NULL DEFAULT false,
    "vipNote" TEXT,
    "lightGuestMemoryJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Guest_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purposeNote" TEXT,
    "filtersJson" TEXT NOT NULL,
    "messageBody" TEXT NOT NULL,
    "linkedOfferId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "audienceCount" INTEGER NOT NULL DEFAULT 0,
    "attemptedCount" INTEGER NOT NULL DEFAULT 0,
    "sentOkCount" INTEGER NOT NULL DEFAULT 0,
    "sentFailedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedNoPhoneCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    CONSTRAINT "MarketingCampaign_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MarketingCampaignRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorDetail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketingCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MarketingCampaignRecipient_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GuestSegmentTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guestId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuestSegmentTag_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "propertyId" TEXT,
    "guestId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'DIRECT',
    "state" TEXT NOT NULL DEFAULT 'NEW',
    "agentHandoffAt" DATETIME,
    "lastMessageAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Conversation_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Conversation_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Conversation_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "direction" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "aiIntent" TEXT,
    "aiConfidence" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BookingGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookingGroup_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "roomUnitId" TEXT,
    "bookingGroupId" TEXT,
    "isPrimaryPayer" BOOLEAN NOT NULL DEFAULT false,
    "guestId" TEXT NOT NULL,
    "conversationId" TEXT,
    "checkIn" DATETIME NOT NULL,
    "checkOut" DATETIME NOT NULL,
    "nights" INTEGER NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 2,
    "children" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'DIRECT',
    "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "referenceCode" TEXT,
    "mealPlan" TEXT,
    "preArrivalReminderSentAt" DATETIME,
    "guestJourneyPreArrival24hSentAt" DATETIME,
    "guestJourneyCheckinDaySentAt" DATETIME,
    "guestJourneyPostCheckoutThankYouSentAt" DATETIME,
    "guestJourneyReviewRequestSentAt" DATETIME,
    "guestJourneyReviewReminderSentAt" DATETIME,
    "guestJourneyRepeatPromoSentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Booking_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Booking_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Booking_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Booking_roomUnitId_fkey" FOREIGN KEY ("roomUnitId") REFERENCES "RoomUnit" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_bookingGroupId_fkey" FOREIGN KEY ("bookingGroupId") REFERENCES "BookingGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Booking_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

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
CREATE TABLE "GuestFeedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "guestId" TEXT,
    "guestName" TEXT,
    "rating" INTEGER NOT NULL,
    "category" TEXT,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_COMMENT',
    "lowRatingAlertedAt" DATETIME,
    "managerFollowUpRequestedAt" DATETIME,
    "managerFollowUpClosedAt" DATETIME,
    "publicReviewClickedAt" DATETIME,
    "isHappyGuest" BOOLEAN NOT NULL DEFAULT false,
    "isPromoter" BOOLEAN NOT NULL DEFAULT false,
    "isIssueCase" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GuestFeedback_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuestFeedback_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuestFeedback_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "outletType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unitPrice" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MenuItem_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FbOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "outletType" TEXT NOT NULL,
    "serviceMode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "totalAmount" REAL NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FbOrder_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FbOrder_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FbOrder_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FbOrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "itemNameSnap" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" REAL NOT NULL,
    "lineTotal" REAL NOT NULL,
    CONSTRAINT "FbOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "FbOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FbOrderLine_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "FolioTransaction" (
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

-- CreateTable
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
    "whatsappNotifyAt" DATETIME,
    "whatsappNotifyOk" BOOLEAN,
    "whatsappNotifyDetail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutletOrderTicket_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutletOrderTicket_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutletOrderTicket_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OutletOrderTicket_fbOrderId_fkey" FOREIGN KEY ("fbOrderId") REFERENCES "FbOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OutletOrderTicket_folioTransactionId_fkey" FOREIGN KEY ("folioTransactionId") REFERENCES "FolioTransaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HousekeepingTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "roomUnitId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL,
    "bookingId" TEXT,
    "assignedToUserId" TEXT,
    "assignmentMode" TEXT,
    "manualAssignedByUserId" TEXT,
    "claimedAt" DATETIME,
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
    CONSTRAINT "HousekeepingTask_manualAssignedByUserId_fkey" FOREIGN KEY ("manualAssignedByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "HousekeepingTask_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "HousekeepingTask_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

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

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "billingCycle" TEXT NOT NULL DEFAULT 'MONTHLY',
    "monthlyPrice" REAL NOT NULL,
    "maxProperties" INTEGER NOT NULL DEFAULT 1,
    "maxRoomTypes" INTEGER NOT NULL DEFAULT 20,
    "maxMonthlyConversations" INTEGER NOT NULL DEFAULT 2000,
    "supportsChannelManager" BOOLEAN NOT NULL DEFAULT false,
    "supportsCustomBranding" BOOLEAN NOT NULL DEFAULT false,
    "supportsAiAutomation" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'TRIALING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodStart" DATETIME,
    "currentPeriodEnd" DATETIME,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "externalCustomerId" TEXT,
    "externalSubscriptionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Subscription_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "externalInvoiceId" TEXT,
    "amountSubtotal" REAL NOT NULL,
    "amountTax" REAL NOT NULL DEFAULT 0,
    "amountTotal" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "dueAt" DATETIME,
    "paidAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Invoice_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "bookingId" TEXT,
    "invoiceId" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "externalIntentId" TEXT,
    "amount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paymentLinkUrl" TEXT,
    "paymentLinkSentAt" DATETIME,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentIntent_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaymentIntent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PaymentIntent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "externalTxnId" TEXT,
    "amount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'OMR',
    "status" TEXT NOT NULL,
    "providerPayload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentTransaction_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaymentTransaction_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "externalHotelId" TEXT,
    "credentialReference" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IntegrationConnection_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChannelMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "integrationConnectionId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "externalRoomId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelMapping_integrationConnectionId_fkey" FOREIGN KEY ("integrationConnectionId") REFERENCES "IntegrationConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChannelMapping_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "integrationConnectionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncJob_integrationConnectionId_fkey" FOREIGN KEY ("integrationConnectionId") REFERENCES "IntegrationConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "propertyId" TEXT,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "bookingId" TEXT,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "guestId" TEXT,
    "propertyId" TEXT,
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
    CONSTRAINT "Notification_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_hotelUserId_fkey" FOREIGN KEY ("hotelUserId") REFERENCES "HotelUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GuestFollowUp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "propertyId" TEXT,
    "bookingId" TEXT,
    "conversationId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "sentAt" DATETIME,
    "cancelledAt" DATETIME,
    "payloadJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GuestFollowUp_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuestFollowUp_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GuestFollowUp_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "GuestFollowUp_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "GuestFollowUp_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

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
CREATE TABLE "OwnerDailyDigestLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "digestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "recipient" TEXT,
    "subject" TEXT,
    "errorMessage" TEXT,
    "alertIdsJson" TEXT,
    "newAlertCount" INTEGER,
    "summaryJson" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
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
CREATE UNIQUE INDEX "Hotel_slug_key" ON "Hotel"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "HotelDailyDigestLog_hotelId_digestKey_key" ON "HotelDailyDigestLog"("hotelId", "digestKey");

-- CreateIndex
CREATE UNIQUE INDEX "HotelUser_hotelId_email_key" ON "HotelUser"("hotelId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "HotelUser_hotelId_username_key" ON "HotelUser"("hotelId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_hotelUserId_createdAt_idx" ON "PasswordResetToken"("hotelUserId", "createdAt");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE INDEX "FrontDeskShift_hotelId_closedAt_idx" ON "FrontDeskShift"("hotelId", "closedAt");

-- CreateIndex
CREATE INDEX "FrontDeskShift_hotelId_shiftStart_idx" ON "FrontDeskShift"("hotelId", "shiftStart");

-- CreateIndex
CREATE INDEX "FrontDeskShift_hotelId_businessDate_idx" ON "FrontDeskShift"("hotelId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "Property_hotelId_name_key" ON "Property"("hotelId", "name");

-- CreateIndex
CREATE INDEX "Lead_hotelId_status_createdAt_idx" ON "Lead"("hotelId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_hotelId_contactEmail_idx" ON "Lead"("hotelId", "contactEmail");

-- CreateIndex
CREATE INDEX "Lead_hotelId_contactPhone_idx" ON "Lead"("hotelId", "contactPhone");

-- CreateIndex
CREATE INDEX "LeadOutreachLog_hotelId_leadId_createdAt_idx" ON "LeadOutreachLog"("hotelId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadOutreachLog_hotelId_channel_sentAt_idx" ON "LeadOutreachLog"("hotelId", "channel", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoomType_propertyId_code_key" ON "RoomType"("propertyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Inventory_roomTypeId_date_key" ON "Inventory"("roomTypeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Guest_hotelId_phoneE164_key" ON "Guest"("hotelId", "phoneE164");

-- CreateIndex
CREATE INDEX "MarketingCampaign_hotelId_createdAt_idx" ON "MarketingCampaign"("hotelId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingCampaignRecipient_campaignId_idx" ON "MarketingCampaignRecipient"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaignRecipient_campaignId_guestId_key" ON "MarketingCampaignRecipient"("campaignId", "guestId");

-- CreateIndex
CREATE INDEX "GuestSegmentTag_guestId_idx" ON "GuestSegmentTag"("guestId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestSegmentTag_guestId_tag_key" ON "GuestSegmentTag"("guestId", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_providerMessageId_key" ON "Message"("conversationId", "providerMessageId");

-- CreateIndex
CREATE INDEX "BookingGroup_hotelId_createdAt_idx" ON "BookingGroup"("hotelId", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_hotelId_referenceCode_idx" ON "Booking"("hotelId", "referenceCode");

-- CreateIndex
CREATE INDEX "Booking_hotelId_bookingGroupId_idx" ON "Booking"("hotelId", "bookingGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_hotelId_referenceCode_key" ON "Booking"("hotelId", "referenceCode");

-- CreateIndex
CREATE INDEX "BookingStatusHistory_hotelId_bookingId_idx" ON "BookingStatusHistory"("hotelId", "bookingId");

-- CreateIndex
CREATE INDEX "BookingStatusHistory_hotelId_createdAt_idx" ON "BookingStatusHistory"("hotelId", "createdAt");

-- CreateIndex
CREATE INDEX "GuestFeedback_hotelId_createdAt_idx" ON "GuestFeedback"("hotelId", "createdAt");

-- CreateIndex
CREATE INDEX "GuestFeedback_hotelId_bookingId_idx" ON "GuestFeedback"("hotelId", "bookingId");

-- CreateIndex
CREATE INDEX "GuestFeedback_hotelId_rating_idx" ON "GuestFeedback"("hotelId", "rating");

-- CreateIndex
CREATE INDEX "GuestFeedback_hotelId_managerFollowUpRequestedAt_managerFollowUpClosedAt_idx" ON "GuestFeedback"("hotelId", "managerFollowUpRequestedAt", "managerFollowUpClosedAt");

-- CreateIndex
CREATE INDEX "Folio_hotelId_bookingId_idx" ON "Folio"("hotelId", "bookingId");

-- CreateIndex
CREATE INDEX "Folio_hotelId_folioStatus_idx" ON "Folio"("hotelId", "folioStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Folio_bookingId_folioCode_key" ON "Folio"("bookingId", "folioCode");

-- CreateIndex
CREATE INDEX "Outlet_hotelId_outletType_isActive_idx" ON "Outlet"("hotelId", "outletType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Outlet_hotelId_code_key" ON "Outlet"("hotelId", "code");

-- CreateIndex
CREATE INDEX "OutletMenuItem_hotelId_outletId_isActive_idx" ON "OutletMenuItem"("hotelId", "outletId", "isActive");

-- CreateIndex
CREATE INDEX "OutletMenuItem_hotelId_itemCode_idx" ON "OutletMenuItem"("hotelId", "itemCode");

-- CreateIndex
CREATE INDEX "PaymentAllocation_hotelId_folioId_idx" ON "PaymentAllocation"("hotelId", "folioId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_paymentTransactionId_idx" ON "PaymentAllocation"("paymentTransactionId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_appliedToTransactionId_idx" ON "PaymentAllocation"("appliedToTransactionId");

-- CreateIndex
CREATE INDEX "MenuItem_hotelId_outletType_isActive_idx" ON "MenuItem"("hotelId", "outletType", "isActive");

-- CreateIndex
CREATE INDEX "FbOrder_hotelId_bookingId_idx" ON "FbOrder"("hotelId", "bookingId");

-- CreateIndex
CREATE INDEX "FbOrder_guestId_idx" ON "FbOrder"("guestId");

-- CreateIndex
CREATE INDEX "FbOrderLine_orderId_idx" ON "FbOrderLine"("orderId");

-- CreateIndex
CREATE INDEX "FbOperationalExpense_hotelId_expenseDate_idx" ON "FbOperationalExpense"("hotelId", "expenseDate");

-- CreateIndex
CREATE INDEX "FolioTransaction_hotelId_bookingId_idx" ON "FolioTransaction"("hotelId", "bookingId");

-- CreateIndex
CREATE INDEX "FolioTransaction_hotelId_folioId_idx" ON "FolioTransaction"("hotelId", "folioId");

-- CreateIndex
CREATE INDEX "FolioTransaction_hotelId_folioId_chargeDate_idx" ON "FolioTransaction"("hotelId", "folioId", "chargeDate");

-- CreateIndex
CREATE INDEX "FolioTransaction_hotelId_roomUnitId_chargeDate_idx" ON "FolioTransaction"("hotelId", "roomUnitId", "chargeDate");

-- CreateIndex
CREATE INDEX "FolioTransaction_bookingId_folioPaymentStatus_idx" ON "FolioTransaction"("bookingId", "folioPaymentStatus");

-- CreateIndex
CREATE INDEX "FolioTransaction_hotelId_ledgerKind_idx" ON "FolioTransaction"("hotelId", "ledgerKind");

-- CreateIndex
CREATE INDEX "FolioTransaction_hotelId_revenueCategory_idx" ON "FolioTransaction"("hotelId", "revenueCategory");

-- CreateIndex
CREATE INDEX "FolioTransaction_hotelId_sourceType_idx" ON "FolioTransaction"("hotelId", "sourceType");

-- CreateIndex
CREATE INDEX "FolioTransaction_hotelId_isVoided_idx" ON "FolioTransaction"("hotelId", "isVoided");

-- CreateIndex
CREATE INDEX "FolioTransaction_hotelId_chargeDate_idx" ON "FolioTransaction"("hotelId", "chargeDate");

-- CreateIndex
CREATE INDEX "FolioTransaction_parentTransactionId_idx" ON "FolioTransaction"("parentTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "OutletOrderTicket_fbOrderId_key" ON "OutletOrderTicket"("fbOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OutletOrderTicket_folioTransactionId_key" ON "OutletOrderTicket"("folioTransactionId");

-- CreateIndex
CREATE INDEX "OutletOrderTicket_hotelId_ticketStatus_idx" ON "OutletOrderTicket"("hotelId", "ticketStatus");

-- CreateIndex
CREATE INDEX "OutletOrderTicket_hotelId_outletKey_idx" ON "OutletOrderTicket"("hotelId", "outletKey");

-- CreateIndex
CREATE INDEX "OutletOrderTicket_hotelId_createdAt_idx" ON "OutletOrderTicket"("hotelId", "createdAt");

-- CreateIndex
CREATE INDEX "HousekeepingTask_hotelId_status_idx" ON "HousekeepingTask"("hotelId", "status");

-- CreateIndex
CREATE INDEX "HousekeepingTask_hotelId_roomUnitId_idx" ON "HousekeepingTask"("hotelId", "roomUnitId");

-- CreateIndex
CREATE INDEX "HousekeepingTask_assignedToUserId_idx" ON "HousekeepingTask"("assignedToUserId");

-- CreateIndex
CREATE INDEX "RoomUnit_hotelId_roomTypeId_isActive_idx" ON "RoomUnit"("hotelId", "roomTypeId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RoomUnit_roomTypeId_name_key" ON "RoomUnit"("roomTypeId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE INDEX "Subscription_hotelId_status_idx" ON "Subscription"("hotelId", "status");

-- CreateIndex
CREATE INDEX "Invoice_hotelId_status_idx" ON "Invoice"("hotelId", "status");

-- CreateIndex
CREATE INDEX "PaymentIntent_hotelId_status_idx" ON "PaymentIntent"("hotelId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_hotelId_provider_key" ON "IntegrationConnection"("hotelId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMapping_integrationConnectionId_roomTypeId_key" ON "ChannelMapping"("integrationConnectionId", "roomTypeId");

-- CreateIndex
CREATE INDEX "AuditLog_hotelId_createdAt_idx" ON "AuditLog"("hotelId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_hotelId_bookingId_idx" ON "AuditLog"("hotelId", "bookingId");

-- CreateIndex
CREATE INDEX "AuditLog_hotelId_propertyId_createdAt_idx" ON "AuditLog"("hotelId", "propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_hotelId_status_idx" ON "Notification"("hotelId", "status");

-- CreateIndex
CREATE INDEX "Notification_hotelId_guestId_idx" ON "Notification"("hotelId", "guestId");

-- CreateIndex
CREATE INDEX "Notification_hotelId_propertyId_idx" ON "Notification"("hotelId", "propertyId");

-- CreateIndex
CREATE INDEX "Notification_hotelId_hotelUserId_idx" ON "Notification"("hotelId", "hotelUserId");

-- CreateIndex
CREATE INDEX "Notification_hotelId_createdAt_idx" ON "Notification"("hotelId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuestFollowUp_dedupeKey_key" ON "GuestFollowUp"("dedupeKey");

-- CreateIndex
CREATE INDEX "GuestFollowUp_hotelId_status_scheduledFor_idx" ON "GuestFollowUp"("hotelId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "GuestFollowUp_hotelId_guestId_type_idx" ON "GuestFollowUp"("hotelId", "guestId", "type");

-- CreateIndex
CREATE INDEX "GuestFollowUp_hotelId_propertyId_status_scheduledFor_idx" ON "GuestFollowUp"("hotelId", "propertyId", "status", "scheduledFor");

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
CREATE UNIQUE INDEX "OwnerDailyDigestLog_digestKey_key" ON "OwnerDailyDigestLog"("digestKey");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarSession_tokenHash_key" ON "CalendarSession"("tokenHash");

-- CreateIndex
CREATE INDEX "CalendarSession_hotelId_expiresAt_idx" ON "CalendarSession"("hotelId", "expiresAt");

-- CreateIndex
CREATE INDEX "CalendarSession_hotelId_phoneE164_idx" ON "CalendarSession"("hotelId", "phoneE164");
