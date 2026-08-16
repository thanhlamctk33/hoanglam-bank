-- CreateEnum
CREATE TYPE "CreditApplyStatus" AS ENUM ('PENDING_CHECKER', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "contractAcceptedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CreditApply" (
    "id" TEXT NOT NULL,
    "requestedAmount" DECIMAL(18,2) NOT NULL,
    "approvedAmount" DECIMAL(18,2),
    "drawnAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "CreditApplyStatus" NOT NULL DEFAULT 'PENDING_CHECKER',
    "makerNote" TEXT,
    "checkerNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "companyId" TEXT NOT NULL,
    "makerId" TEXT NOT NULL,
    "checkerId" TEXT,

    CONSTRAINT "CreditApply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Drawdown" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "interestRatePct" DECIMAL(5,2) NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    "creditApplyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,

    CONSTRAINT "Drawdown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repayment" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    "creditApplyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,

    CONSTRAINT "Repayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditApply_companyId_status_idx" ON "CreditApply"("companyId", "status");

-- CreateIndex
CREATE INDEX "Drawdown_companyId_createdAt_idx" ON "Drawdown"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Drawdown_creditApplyId_idx" ON "Drawdown"("creditApplyId");

-- CreateIndex
CREATE INDEX "Repayment_companyId_createdAt_idx" ON "Repayment"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Repayment_creditApplyId_idx" ON "Repayment"("creditApplyId");
