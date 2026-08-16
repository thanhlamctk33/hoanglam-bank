-- CreateTable
CREATE TABLE "MerchantCategory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchantCategory_companyId_idx" ON "MerchantCategory"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantCategory_companyId_name_key" ON "MerchantCategory"("companyId", "name");
