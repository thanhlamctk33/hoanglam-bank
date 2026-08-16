import { prisma } from "../../lib/prisma";

/** All direct Prisma access for credit applies/primary accounts lives here — credit.service.ts never touches `prisma` itself. */
export function findActiveCreditApply(companyId: string) {
  return prisma.creditApply.findFirst({
    where: { companyId, status: { in: ["PENDING_MAKER", "PENDING_CHECKER", "APPROVED"] } },
    orderBy: { createdAt: "desc" },
  });
}

export function findFirstAccountByCompany(companyId: string) {
  return prisma.account.findFirst({ where: { companyId }, orderBy: { createdAt: "asc" } });
}

export function createAccount(data: { name: string; currency: string; balance: number; accountNumber: string; companyId: string }) {
  return prisma.account.create({ data });
}

export function findAccountIdsByCompany(companyId: string) {
  return prisma.account.findMany({ where: { companyId }, select: { id: true } });
}

export function findTransactionsSince(accountIds: string[], since: Date) {
  return prisma.transaction.findMany({
    where: { accountId: { in: accountIds }, date: { gte: since }, status: "COMPLETED" },
    select: { amount: true, type: true },
  });
}

export function findOverdueBills(companyId: string, now: Date) {
  return prisma.bill.findMany({
    where: { companyId, status: "UNPAID", dueDate: { lt: now } },
    select: { amount: true },
  });
}

export function findDrawdownsByCreditApply(creditApplyId: string) {
  return prisma.drawdown.findMany({ where: { creditApplyId }, orderBy: { createdAt: "asc" } });
}

export function findRepaymentsByCreditApply(creditApplyId: string) {
  return prisma.repayment.findMany({ where: { creditApplyId }, orderBy: { createdAt: "asc" } });
}

export function findCompanyKybAndContract(companyId: string) {
  return prisma.company.findUnique({
    where: { id: companyId },
    select: { kybStatus: true, contractAcceptedAt: true },
  });
}

export function findDrawdownIdsByCompany(companyId: string) {
  return prisma.drawdown.findMany({ where: { companyId }, select: { id: true } });
}

export function findOverdueInstallment(drawdownIds: string[], now: Date) {
  return prisma.installment.findFirst({
    where: { status: { not: "PAID" }, dueDate: { lt: now }, drawdownId: { in: drawdownIds } },
    select: { id: true },
  });
}

export function countUnfrozenAccounts(companyId: string) {
  return prisma.account.count({ where: { companyId, frozen: false } });
}
