-- HotelUser: add housekeeping role support + username/pin login.
-- SQLite requires table rebuild for making email nullable.
PRAGMA foreign_keys=OFF;

ALTER TABLE "HotelUser" RENAME TO "HotelUser_old";

CREATE TABLE "HotelUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hotelId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "username" TEXT,
    "pinHash" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MANAGER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HotelUser_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "HotelUser" (
    "id", "hotelId", "fullName", "email", "passwordHash", "role", "isActive", "createdAt", "updatedAt"
)
SELECT
    "id", "hotelId", "fullName", "email", "passwordHash", "role", "isActive", "createdAt", "updatedAt"
FROM "HotelUser_old";

DROP TABLE "HotelUser_old";

CREATE UNIQUE INDEX "HotelUser_hotelId_email_key" ON "HotelUser"("hotelId", "email");
CREATE UNIQUE INDEX "HotelUser_hotelId_username_key" ON "HotelUser"("hotelId", "username");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
