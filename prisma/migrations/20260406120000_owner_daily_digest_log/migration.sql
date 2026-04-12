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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "OwnerDailyDigestLog_digestKey_key" ON "OwnerDailyDigestLog"("digestKey");
