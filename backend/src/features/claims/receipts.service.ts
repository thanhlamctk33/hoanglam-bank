import { NotFoundError } from "../../errors/AppError";
import { extractReceiptFields, OCR_MIME_TYPES } from "./ocr.service";
import { isAiConfigured } from "../../config/env";
import { logger } from "../../lib/logger";
import * as claimsRepo from "./claims.repository";

/**
 * Business logic for the standalone receipt library (upload now, attach to
 * a claim later). Shares claims.repository.ts since receipts live alongside
 * claims in the same feature folder.
 */

export function listReceipts(companyId: string) {
  return claimsRepo.findReceiptsByCompany(companyId);
}

export interface UploadReceiptParams {
  imageBase64: string;
  filename: string;
  mimeType: string;
}

export async function uploadReceipt(companyId: string, userId: string, params: UploadReceiptParams) {
  const { imageBase64, filename, mimeType } = params;

  let extractedTitle: string | null = null;
  let extractedAmount: number | null = null;

  if (isAiConfigured && (OCR_MIME_TYPES as readonly string[]).includes(mimeType)) {
    try {
      const result = await extractReceiptFields(imageBase64, mimeType as (typeof OCR_MIME_TYPES)[number]);
      extractedTitle = result.title;
      extractedAmount = result.amount;
    } catch (err) {
      // Best-effort extraction — the receipt still gets saved without
      // pre-filled title/amount if OCR fails, so this is intentionally
      // swallowed rather than rethrown.
      logger.error({ err }, "Receipt library OCR error");
    }
  }

  return claimsRepo.createReceipt({
    url: `data:${mimeType};base64,${imageBase64}`,
    filename,
    mimeType,
    extractedTitle,
    extractedAmount,
    companyId,
    uploadedById: userId,
  });
}

export async function deleteReceipt(companyId: string, receiptId: string) {
  const receipt = await claimsRepo.findOwnReceipt(companyId, receiptId);
  if (!receipt) {
    throw new NotFoundError("Receipt not found");
  }
  await claimsRepo.deleteReceipt(receipt.id);
}
