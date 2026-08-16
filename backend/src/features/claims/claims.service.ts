import { randomUUID } from "crypto";
import { BadGatewayError, NotFoundError, PaymentRequiredError, ServiceUnavailableError } from "../../errors/AppError";
import { extractReceiptFields, OCR_MIME_TYPES } from "./ocr.service";
import { isAiConfigured } from "../../config/env";
import { checkLimit } from "../subscription/subscription.service";
import { writeAuditLog, resolveActorEmail } from "../../shared/audit/audit.service";
import { convertCurrency } from "../../shared/fx/fx.service";
import { DEFAULT_CLAIM_FLAG_LIMIT } from "../spendPolicy/spendPolicy.config";
import { hasApprovalPower } from "../../middleware/companyAdmin";
import { logger } from "../../lib/logger";
import * as claimsRepo from "./claims.repository";

/**
 * Business logic for expense claims — every route in claims.routes.ts is a
 * thin validate-then-call-this wrapper. All Prisma access goes through
 * claims.repository.ts.
 */

// Fallback for companies with no spend policy row yet — shared with
// features/spendPolicy so the default can't drift between the two.

// Claims at or above this amount are flagged for admin attention. Configured
// per-company at Spend > Policies. The limit is always set in USD, so claim
// amounts are converted to USD before comparing.
async function getClaimFlagLimit(companyId: string | undefined): Promise<number> {
  if (!companyId) return DEFAULT_CLAIM_FLAG_LIMIT;
  const policy = await claimsRepo.findSpendPolicy(companyId);
  return policy ? Number(policy.claimFlagLimit) : DEFAULT_CLAIM_FLAG_LIMIT;
}

export function listClaims(companyId: string) {
  return claimsRepo.findClaimsByCompany(companyId);
}

export interface CreateClaimParams {
  title: string;
  amount: number;
  currency: string;
  category?: string;
  description?: string;
  receiptUrl: string;
  additionalReceiptUrls?: string[];
}

export async function createClaim(companyId: string, userId: string, params: CreateClaimParams) {
  const limitCheck = await checkLimit(companyId, "claim");
  if (!limitCheck.allowed) {
    throw new PaymentRequiredError(limitCheck.message);
  }

  const flagLimit = await getClaimFlagLimit(companyId);
  const amountInUsd = convertCurrency(params.amount, params.currency, "USD");
  const actor = await claimsRepo.findUserById(userId);

  const claim = await claimsRepo.createClaim({
    ...params,
    status: hasApprovalPower(actor) ? "APPROVED" : "PENDING",
    flagged: amountInUsd > flagLimit,
    companyId,
    submittedById: userId,
  });

  await writeAuditLog({
    action: claim.status === "APPROVED" ? "CLAIM_SUBMITTED_AUTO_APPROVED" : "CLAIM_SUBMITTED",
    actorEmail: actor?.email ?? "unknown",
    targetType: "Claim",
    targetId: claim.id,
    metadata: { title: claim.title, amount: claim.amount.toString() },
  });

  return claim;
}

export interface BulkClaimRow {
  title: string;
  amount: number;
  currency: string;
  category?: string;
  description?: string;
  receiptUrl: string;
}

export async function createClaimsBulk(companyId: string, userId: string, rows: BulkClaimRow[]) {
  const limitCheck = await checkLimit(companyId, "claim", rows.length);
  if (!limitCheck.allowed) {
    throw new PaymentRequiredError(limitCheck.message);
  }

  const actor = await claimsRepo.findUserById(userId);
  const status = hasApprovalPower(actor) ? "APPROVED" : "PENDING";
  const batchId = randomUUID();
  const flagLimit = await getClaimFlagLimit(companyId);

  const claims = await claimsRepo.createClaims(
    rows.map((c) => ({
      ...c,
      status,
      flagged: convertCurrency(c.amount, c.currency, "USD") > flagLimit,
      batchId,
      companyId,
      submittedById: userId,
    }))
  );

  return { claims, batchId };
}

export async function parseReceipt(imageBase64: string, mimeType: (typeof OCR_MIME_TYPES)[number]) {
  if (!isAiConfigured) {
    throw new ServiceUnavailableError("Receipt scanning is not configured. Set ANTHROPIC_API_KEY in backend/.env.");
  }

  try {
    return await extractReceiptFields(imageBase64, mimeType);
  } catch (err) {
    logger.error({ err }, "Receipt parse error");
    throw new BadGatewayError("Failed to read the receipt.");
  }
}

export async function setClaimStatus(
  companyId: string,
  claimId: string,
  status: "PENDING" | "APPROVED" | "REJECTED",
  userId: string
) {
  const claim = await claimsRepo.findOwnClaim(companyId, claimId);
  if (!claim) {
    throw new NotFoundError("Claim not found");
  }

  const updated = await claimsRepo.updateClaimStatus(claim.id, status);

  await writeAuditLog({
    action: `CLAIM_${status}`,
    actorEmail: await resolveActorEmail(userId),
    targetType: "Claim",
    targetId: claim.id,
    metadata: { title: claim.title, amount: claim.amount.toString() },
  });

  return updated;
}

export async function setBatchStatus(
  companyId: string,
  batchId: string,
  status: "PENDING" | "APPROVED" | "REJECTED",
  userId: string
) {
  const result = await claimsRepo.updatePendingClaimsStatus({ companyId, batchId }, status);

  if (result.count > 0) {
    await writeAuditLog({
      action: `CLAIM_BATCH_${status}`,
      actorEmail: await resolveActorEmail(userId),
      targetType: "Claim",
      targetId: batchId,
      metadata: { count: String(result.count) },
    });
  }
}

export async function setBulkStatus(companyId: string, ids: string[], status: "APPROVED" | "REJECTED", userId: string) {
  const result = await claimsRepo.updatePendingClaimsStatus({ companyId, ids }, status);

  if (result.count > 0) {
    await writeAuditLog({
      action: `CLAIM_BULK_${status}`,
      actorEmail: await resolveActorEmail(userId),
      targetType: "Claim",
      metadata: { count: String(result.count) },
    });
  }
}

export async function deleteClaim(companyId: string, claimId: string, userId: string) {
  const claim = await claimsRepo.findOwnClaim(companyId, claimId);
  if (!claim) {
    throw new NotFoundError("Claim not found");
  }

  await claimsRepo.deleteClaim(claim.id);

  await writeAuditLog({
    action: "CLAIM_DELETED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Claim",
    targetId: claim.id,
    metadata: { title: claim.title, amount: claim.amount.toString() },
  });
}
