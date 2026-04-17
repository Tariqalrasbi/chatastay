-- HousekeepingTask: assignment audit + fair auto-assign metadata
-- SQLite: add nullable columns (existing rows unchanged).

ALTER TABLE "HousekeepingTask" ADD COLUMN "assignmentMode" TEXT;
ALTER TABLE "HousekeepingTask" ADD COLUMN "manualAssignedByUserId" TEXT;
ALTER TABLE "HousekeepingTask" ADD COLUMN "claimedAt" DATETIME;
