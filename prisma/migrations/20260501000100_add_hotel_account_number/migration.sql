-- Stable numeric hotel account number for Extranet/admin login.
-- Nullable for safe rollout; app startup backfills existing hotels by creation order.
ALTER TABLE "Hotel" ADD COLUMN "accountNumber" INTEGER;

CREATE UNIQUE INDEX "Hotel_accountNumber_key" ON "Hotel"("accountNumber");
