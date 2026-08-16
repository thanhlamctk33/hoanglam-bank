-- CreateEnum
CREATE TYPE "RepaymentMethod" AS ENUM ('REVOLVING', 'AMORTIZING', 'INTEREST_ONLY', 'BALLOON');
CREATE TYPE "InstallmentStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'OVERDUE');
CREATE TYPE "RepaymentSource" AS ENUM ('MANUAL', 'AUTO_DEDUCT');

-- AlterTable: Drawdown gains its repayment terms. Existing rows default to
-- REVOLVING (the original free-form behavior), so nothing already drawn
-- down changes behavior.
ALTER TABLE "Drawdown" ADD COLUMN "repaymentMethod" "RepaymentMethod" NOT NULL DEFAULT 'REVOLVING';
ALTER TABLE "Drawdown" ADD COLUMN "graceMonths" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Drawdown" ADD COLUMN "autoDeduct" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Drawdown" ADD COLUMN "autoDeductAccountId" TEXT;

-- CreateTable
CREATE TABLE "Installment" (
    "id" TEXT NOT NULL,
    "drawdownId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "principalDue" DECIMAL(18,2) NOT NULL,
    "interestDue" DECIMAL(18,2) NOT NULL,
    "feeDue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidPrincipal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidInterest" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidFee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'PENDING',
    "lateFeeApplied" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Installment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Installment_drawdownId_sequence_idx" ON "Installment"("drawdownId", "sequence");
CREATE INDEX "Installment_drawdownId_dueDate_idx" ON "Installment"("drawdownId", "dueDate");

-- AlterTable: Repayment gains a source, a waterfall breakdown, and an
-- optional link to the specific drawdown it targeted. Existing rows were
-- all pooled/manual repayments against the revolving balance, so backfill
-- them as fully-principal MANUAL repayments (matching how they were
-- actually applied at the time).
ALTER TABLE "Repayment" ADD COLUMN "source" "RepaymentSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "Repayment" ADD COLUMN "principalPaid" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "Repayment" ADD COLUMN "interestPaid" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "Repayment" ADD COLUMN "feePaid" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "Repayment" ADD COLUMN "drawdownId" TEXT;

UPDATE "Repayment" SET "principalPaid" = "amount" WHERE "principalPaid" = 0;

CREATE INDEX "Repayment_drawdownId_idx" ON "Repayment"("drawdownId");
