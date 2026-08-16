-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CHECKING', 'SAVINGS');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "type" "AccountType" NOT NULL DEFAULT 'CHECKING';
