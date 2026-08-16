-- AlterEnum
ALTER TYPE "CardType" ADD VALUE 'PREPAID';

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "accountId" TEXT;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
