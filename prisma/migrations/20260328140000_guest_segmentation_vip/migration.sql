-- RedefineEnums: Prisma will map enums as strings in SQLite
-- CreateTable
CREATE TABLE "GuestSegmentTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guestId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuestSegmentTag_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "GuestSegmentTag_guestId_tag_key" ON "GuestSegmentTag"("guestId", "tag");
CREATE INDEX "GuestSegmentTag_guestId_idx" ON "GuestSegmentTag"("guestId");

-- AlterTable
ALTER TABLE "Guest" ADD COLUMN "isVip" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Guest" ADD COLUMN "vipNote" TEXT;
