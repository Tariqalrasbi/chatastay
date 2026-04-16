ALTER TABLE "AuditLog" ADD COLUMN "propertyId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "propertyId" TEXT;
ALTER TABLE "GuestFollowUp" ADD COLUMN "propertyId" TEXT;

CREATE INDEX "AuditLog_hotelId_propertyId_createdAt_idx"
  ON "AuditLog"("hotelId", "propertyId", "createdAt");
CREATE INDEX "Notification_hotelId_propertyId_idx"
  ON "Notification"("hotelId", "propertyId");
CREATE INDEX "GuestFollowUp_hotelId_propertyId_status_scheduledFor_idx"
  ON "GuestFollowUp"("hotelId", "propertyId", "status", "scheduledFor");

ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GuestFollowUp"
  ADD CONSTRAINT "GuestFollowUp_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
