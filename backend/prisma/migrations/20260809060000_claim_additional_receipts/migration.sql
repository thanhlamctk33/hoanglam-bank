-- AlterTable
ALTER TABLE "Claim" ADD COLUMN "additionalReceiptUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
