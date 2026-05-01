-- Manual paid check-in payments were posted with the stay check-in date as
-- chargeDate. Financial/cashier reports use chargeDate as the payment posting
-- date, so move only those historical manual check-in payments back to their
-- original row creation timestamp.
UPDATE "FolioTransaction"
SET "chargeDate" = "createdAt"
WHERE "transactionType" = 'PAYMENT'
  AND "sourceType" = 'MANUAL_FRONTDESK'
  AND "notes" = 'Payment recorded during manual check-in.'
  AND "createdAt" IS NOT NULL;
