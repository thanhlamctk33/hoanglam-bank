import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";

/**
 * Thin Prisma wrappers for expense claims and the receipt library —
 * claims.service.ts / receipts.service.ts never touch `prisma` themselves.
 */

// --- Claims ------------------------------------------------------------------

export function findClaimsByCompany(companyId: string) {
  return prisma.claim.findMany({
    where: { companyId },
    include: { submittedBy: { select: { id: true, name: true } } },
    orderBy: { submittedAt: "desc" },
  });
}

export function findOwnClaim(companyId: string, id: string) {
  return prisma.claim.findFirst({ where: { id, companyId } });
}

export function createClaim(data: Prisma.ClaimUncheckedCreateInput) {
  return prisma.claim.create({ data });
}

/** Creates a batch of claims atomically — one rejected row shouldn't leave a half-imported batch. */
export function createClaims(claims: Prisma.ClaimUncheckedCreateInput[]) {
  return prisma.$transaction(claims.map((data) => prisma.claim.create({ data })));
}

export function updateClaimStatus(id: string, status: "PENDING" | "APPROVED" | "REJECTED") {
  return prisma.claim.update({ where: { id }, data: { status } });
}

/** Bulk status change, scoped to still-PENDING claims so an already-decided claim isn't silently flipped. */
export function updatePendingClaimsStatus(
  where: { companyId: string; batchId?: string; ids?: string[] },
  status: "PENDING" | "APPROVED" | "REJECTED"
) {
  return prisma.claim.updateMany({
    where: {
      companyId: where.companyId,
      status: "PENDING",
      ...(where.batchId ? { batchId: where.batchId } : {}),
      ...(where.ids ? { id: { in: where.ids } } : {}),
    },
    data: { status },
  });
}

export function deleteClaim(id: string) {
  return prisma.claim.delete({ where: { id } });
}

// --- Related lookups ------------------------------------------------------------

export function findUserById(userId: string) {
  return prisma.user.findUnique({ where: { id: userId } });
}

export function findSpendPolicy(companyId: string) {
  return prisma.spendPolicy.findUnique({ where: { companyId } });
}

// --- Receipt library --------------------------------------------------------------

export function findReceiptsByCompany(companyId: string) {
  return prisma.receipt.findMany({
    where: { companyId },
    include: { uploadedBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export function findOwnReceipt(companyId: string, id: string) {
  return prisma.receipt.findFirst({ where: { id, companyId } });
}

export function createReceipt(data: Prisma.ReceiptUncheckedCreateInput) {
  return prisma.receipt.create({
    data,
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
}

export function deleteReceipt(id: string) {
  return prisma.receipt.delete({ where: { id } });
}
