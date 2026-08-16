-- AlterEnum
ALTER TYPE "CreditApplyStatus" ADD VALUE 'PENDING_MAKER';

-- AlterTable
ALTER TABLE "CreditApply" ALTER COLUMN "makerId" DROP NOT NULL;
ALTER TABLE "CreditApply" ADD COLUMN "purpose" TEXT;
ALTER TABLE "CreditApply" ADD COLUMN "submittedById" TEXT;
ALTER TABLE "CreditApply" ADD COLUMN "offeredInterestRatePct" DECIMAL(5,2);
ALTER TABLE "CreditApply" ADD COLUMN "offeredTermMonths" INTEGER;
