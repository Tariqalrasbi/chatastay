-- Stable numeric hotel account number for Extranet/admin login.
ALTER TABLE "Hotel" ADD COLUMN "accountNumber" INTEGER;

UPDATE "Hotel"
SET "accountNumber" = (
  SELECT ranked.rn
  FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, id ASC) AS rn
    FROM "Hotel"
  ) AS ranked
  WHERE ranked.id = "Hotel".id
)
WHERE "accountNumber" IS NULL;

CREATE UNIQUE INDEX "Hotel_accountNumber_key" ON "Hotel"("accountNumber");
