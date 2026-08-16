import { prisma } from "../../lib/prisma";

/**
 * Thin Prisma wrappers for the notification bell —
 * notifications.service.ts never touches `prisma` itself. Everything here is
 * a read: notifications are derived on the fly from existing tables rather
 * than stored in one of their own.
 */

export function findUserById(userId: string) {
  return prisma.user.findUnique({ where: { id: userId } });
}

export function findBillsDueBy(companyId: string, dueBefore: Date) {
  return prisma.bill.findMany({
    where: { companyId, status: { in: ["UNPAID", "OVERDUE"] }, dueDate: { lte: dueBefore } },
    orderBy: { dueDate: "asc" },
  });
}

export function findFrozenBudgets(companyId: string) {
  return prisma.budget.findMany({ where: { companyId, status: "FROZEN" } });
}

export function findPendingApprovals(companyId: string) {
  return prisma.approvalRequest.findMany({ where: { companyId, status: "PENDING" }, orderBy: { createdAt: "desc" } });
}

export function findPendingClaims(companyId: string) {
  return prisma.claim.findMany({ where: { companyId, status: "PENDING" }, orderBy: { submittedAt: "desc" } });
}

export function findLatestApprovedCredit(companyId: string) {
  return prisma.creditApply.findFirst({ where: { companyId, status: "APPROVED" }, orderBy: { decidedAt: "desc" } });
}

export function findActiveAlertRules(companyId: string) {
  return prisma.alertRule.findMany({ where: { companyId, active: true } });
}

export function findAccounts(companyId: string) {
  return prisma.account.findMany({ where: { companyId } });
}

export function findRecentDebits(accountIds: string[], since: Date) {
  return prisma.transaction.findMany({
    where: { accountId: { in: accountIds }, type: "DEBIT", date: { gte: since } },
    orderBy: { date: "desc" },
  });
}

export function findCompanyContract(companyId: string) {
  return prisma.company.findUnique({ where: { id: companyId }, select: { contractAcceptedAt: true } });
}
