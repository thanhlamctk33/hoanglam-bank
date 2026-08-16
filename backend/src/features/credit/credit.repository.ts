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

// --- Company / contract ---------------------------------------------------------

export function findCompanyById(companyId: string) {
  return prisma.company.findUnique({ where: { id: companyId } });
}

export function acceptContract(companyId: string) {
  return prisma.company.update({ where: { id: companyId }, data: { contractAcceptedAt: new Date() } });
}

// --- Credit applies ---------------------------------------------------------------

export function findCreditAppliesByCompany(companyId: string) {
  return prisma.creditApply.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}

export function createCreditApply(data: {
  companyId: string;
  requestedAmount: number;
  purpose?: string;
  submittedById: string;
}) {
  return prisma.creditApply.create({ data: { ...data, status: "PENDING_MAKER" } });
}

export function approveCreditApplyRecord(
  id: string,
  data: {
    approvedAmount: number;
    offeredInterestRatePct: number;
    offeredTermMonths: number;
    makerId: string | null;
    checkerId: string | null;
    checkerNote: string;
  }
) {
  return prisma.creditApply.update({
    where: { id },
    data: { status: "APPROVED", ...data, decidedAt: new Date() },
  });
}

export function findStaffUsers(take: number) {
  return prisma.user.findMany({ where: { isStaff: true }, take });
}

// --- Demo reset -----------------------------------------------------------------------

export function deleteDrawdownsByCompany(companyId: string) {
  return prisma.drawdown.deleteMany({ where: { companyId } });
}

export function deleteRepaymentsByCompany(companyId: string) {
  return prisma.repayment.deleteMany({ where: { companyId } });
}

export function deleteCreditAppliesByCompany(companyId: string) {
  return prisma.creditApply.deleteMany({ where: { companyId } });
}
