-- Property lifecycle: add status / statusChangedAt / statusReason columns.
-- Existing rows are migrated to status = 'ACTIVE' so behaviour is preserved on upgrade.
-- SQLite has no ALTER COLUMN, so Prisma rebuilds the table; the INSERT below preserves all data.
-- PropertyStatus enum values (validated client-side by Prisma): DRAFT | ACTIVE | SUSPENDED | ARCHIVED.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Property" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "addressLine1" TEXT,
    "checkInTime" TEXT,
    "checkOutTime" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "statusChangedAt" DATETIME,
    "statusReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Property_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Property" ("addressLine1", "checkInTime", "checkOutTime", "city", "createdAt", "hotelId", "id", "name", "updatedAt") SELECT "addressLine1", "checkInTime", "checkOutTime", "city", "createdAt", "hotelId", "id", "name", "updatedAt" FROM "Property";
DROP TABLE "Property";
ALTER TABLE "new_Property" RENAME TO "Property";
CREATE UNIQUE INDEX "Property_hotelId_name_key" ON "Property"("hotelId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
