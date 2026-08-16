-- CreateEnum
CREATE TYPE "RecurringFrequency" AS ENUM ('WEEKLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "autopayAccountId" TEXT;

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "allowOnline" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowAtm" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "blockedCategories" TEXT;

-- CreateTable
CREATE TABLE "RecurringTransfer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "toAccountNumber" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "frequency" "RecurringFrequency" NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedPayee" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedPayee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringTransfer_companyId_active_idx" ON "RecurringTransfer"("companyId", "active");

-- CreateIndex
CREATE INDEX "SavedPayee_companyId_idx" ON "SavedPayee"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedPayee_companyId_accountNumber_key" ON "SavedPayee"("companyId", "accountNumber");
