-- CreateEnum
CREATE TYPE "InterbankLoanType" AS ENUM ('UNSECURED', 'REPO');
CREATE TYPE "InterbankLoanStatus" AS ENUM ('ACTIVE', 'SETTLED', 'DEFAULTED');

-- CreateTable
CREATE TABLE "CounterpartyBank" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "swiftCode" TEXT NOT NULL,
    "creditLimit" DECIMAL(18,2) NOT NULL,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CounterpartyBank_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CounterpartyBank_swiftCode_key" ON "CounterpartyBank"("swiftCode");
CREATE INDEX "CounterpartyBank_name_idx" ON "CounterpartyBank"("name");

-- CreateTable
CREATE TABLE "InterbankLoan" (
    "id" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "type" "InterbankLoanType" NOT NULL DEFAULT 'UNSECURED',
    "principal" DECIMAL(18,2) NOT NULL,
    "interestRatePct" DECIMAL(5,2) NOT NULL,
    "termDays" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "maturityDate" TIMESTAMP(3) NOT NULL,
    "collateralDescription" TEXT,
    "collateralValue" DECIMAL(18,2),
    "status" "InterbankLoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "interestReceived" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "settledAt" TIMESTAMP(3),
    "defaultedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterbankLoan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InterbankLoan_counterpartyId_status_idx" ON "InterbankLoan"("counterpartyId", "status");
CREATE INDEX "InterbankLoan_status_maturityDate_idx" ON "InterbankLoan"("status", "maturityDate");

-- CreateTable
CREATE TABLE "TreasuryBook" (
    "id" TEXT NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL DEFAULT 50000000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreasuryBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreasuryTransaction" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "type" "TransactionType" NOT NULL,
    "description" TEXT NOT NULL,
    "interbankLoanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasuryTransaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TreasuryTransaction_createdAt_idx" ON "TreasuryTransaction"("createdAt");

-- No seed row here — the singleton TreasuryBook is lazily created (with its
-- starting capital) the first time it's read, same "getOrCreate" pattern
-- already used for a company's primary cash Account.
