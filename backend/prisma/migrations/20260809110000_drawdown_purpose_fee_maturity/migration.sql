-- AlterTable
ALTER TABLE "Drawdown" ADD COLUMN "purpose" TEXT;
ALTER TABLE "Drawdown" ADD COLUMN "feeAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "Drawdown" ADD COLUMN "maturityDate" TIMESTAMP(3);

-- Backfill maturityDate for existing rows from createdAt + termMonths, then
-- make it required now that every row has a value.
UPDATE "Drawdown" SET "maturityDate" = "createdAt" + ("termMonths" || ' months')::interval WHERE "maturityDate" IS NULL;
ALTER TABLE "Drawdown" ALTER COLUMN "maturityDate" SET NOT NULL;
