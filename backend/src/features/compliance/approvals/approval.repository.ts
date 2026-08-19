import { prisma } from "../../../lib/prisma";

/**
 * All direct Prisma access for the company-side approval queue lives here —
 * approval.service.ts never touches `prisma` itself. The bank-staff,
 * cross-company view has its own pair under features/admin.
 */

export function createApprovalRequestRecord(input: {
  targetType: "CARD" | "BUDGET";
  targetId: string;
  companyId: string;
  requesterId: string;
  metadata: string;
}) {
  return prisma.approvalRequest.create({
    data: {
      targetType: input.targetType,
      targetId: input.targetId,
      companyId: input.companyId,
      requesterId: input.requesterId,
      metadata: input.metadata,
    },
  });
}

export function findPendingRequests(companyId: string, targetType?: "CARD" | "BUDGET") {
  return prisma.approvalRequest.findMany({
    where: { companyId, status: "PENDING", ...(targetType ? { targetType } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

/** Scoped to PENDING so an already-reviewed request can't be decided twice. */
export function findPendingRequestById(companyId: string, id: string) {
  return prisma.approvalRequest.findFirst({ where: { id, companyId, status: "PENDING" } });
}

export function approveRequestRecord(id: string, reviewerId: string) {
  return prisma.approvalRequest.update({
    where: { id },
    data: { status: "APPROVED", reviewerId, reviewedAt: new Date() },
  });
}

export function rejectRequestRecord(id: string, reviewerId: string, reason: string) {
  return prisma.approvalRequest.update({
    where: { id },
    data: { status: "REJECTED", reason, reviewerId, reviewedAt: new Date() },
  });
}

export function findUsersByIds(ids: string[]) {
  return prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
}

// --- Approval targets --------------------------------------------------------------

export function activateCard(cardId: string) {
  return prisma.card.update({ where: { id: cardId }, data: { status: "ACTIVE" } });
}

export function activateBudget(budgetId: string) {
  return prisma.budget.update({ where: { id: budgetId }, data: { status: "ACTIVE" } });
}

export function rejectCard(cardId: string, rejectionReason: string) {
  return prisma.card.update({ where: { id: cardId }, data: { status: "REJECTED", rejectionReason } });
}

export function rejectBudget(budgetId: string, rejectionReason: string) {
  return prisma.budget.update({ where: { id: budgetId }, data: { status: "REJECTED", rejectionReason } });
}
