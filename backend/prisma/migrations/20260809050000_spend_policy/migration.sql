-- CreateTable
CREATE TABLE "SpendPolicy" (
    "id" TEXT NOT NULL,
    "cardSpendLimitCap" DECIMAL(18,2),
    "budgetAmountCap" DECIMAL(18,2),
    "approvalThreshold" DECIMAL(18,2),
    "claimFlagLimit" DECIMAL(18,2) NOT NULL DEFAULT 500,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "SpendPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpendPolicy_companyId_key" ON "SpendPolicy"("companyId");

-- AddForeignKey
ALTER TABLE "SpendPolicy" ADD CONSTRAINT "SpendPolicy_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
