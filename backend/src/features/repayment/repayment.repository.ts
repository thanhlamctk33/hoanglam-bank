import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

/** All direct Prisma access for repayments/installments lives here — repayment.service.ts never touches `prisma` itself. */
export function findDrawdownIdsByCompany(companyId: string) {
  return prisma.drawdown.findMany({ where: { companyId }, select: { id: true } });
}

export function findOverdueInstallments(drawdownIds: string[], now: Date) {
  return prisma.installment.findMany({
    where: {
      status: { in: ["PENDING", "PARTIAL"] },
      dueDate: { lt: now },
      drawdownId: { in: drawdownIds },
    },
  });
}

export function updateInstallment(id: string, data: Prisma.InstallmentUpdateInput) {
  return prisma.installment.update({ where: { id }, data });
}

export function findUnpaidInstallmentsByDrawdown(drawdownId: string) {
  return prisma.installment.findMany({ where: { drawdownId, status: { not: "PAID" } } });
}

export function findAutoDeductDrawdowns(companyId: string) {
  return prisma.drawdown.findMany({
    where: { companyId, autoDeduct: true, repaymentMethod: { not: "REVOLVING" } },
  });
}

export function findDueInstallments(drawdownId: string, now: Date) {
  return prisma.installment.findMany({
    where: {
      drawdownId,
      status: { in: ["PENDING", "PARTIAL", "OVERDUE"] },
      dueDate: { lte: now },
    },
  });
}

export function findAccountForAutoDeduct(accountId: string, companyId: string) {
  return prisma.account.findFirst({ where: { id: accountId, companyId } });
}

/** Thin passthrough to prisma.$transaction — lets repayment.service.ts run multi-step writes atomically without importing `prisma` itself. */
export function runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}

type Db = Prisma.TransactionClient | typeof prisma;

// --- Repayments -------------------------------------------------------------------

export function findRepaymentsByCompany(companyId: string) {
  return prisma.repayment.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}

export function createRepayment(data: Prisma.RepaymentUncheckedCreateInput, db: Db = prisma) {
  return db.repayment.create({ data });
}

export function deleteRepaymentsByCompany(companyId: string) {
  return prisma.repayment.deleteMany({ where: { companyId } });
}

// --- Drawdowns / credit line -----------------------------------------------------------

export function findOwnDrawdown(companyId: string, id: string) {
  return prisma.drawdown.findFirst({ where: { id, companyId } });
}

export function findDrawdownsByCompany(companyId: string) {
  return prisma.drawdown.findMany({ where: { companyId } });
}

export function findCreditAppliesByCompany(companyId: string) {
  return prisma.creditApply.findMany({ where: { companyId } });
}

export function decrementDrawnAmount(creditApplyId: string, amount: number, db: Db = prisma) {
  return db.creditApply.update({ where: { id: creditApplyId }, data: { drawnAmount: { decrement: amount } } });
}

export function setDrawnAmount(creditApplyId: string, amount: number) {
  return prisma.creditApply.update({ where: { id: creditApplyId }, data: { drawnAmount: amount } });
}

/** Rewinds every installment to a freshly-disbursed state — demo reset only. */
export function resetInstallments(drawdownIds: string[]) {
  return prisma.installment.updateMany({
    where: { drawdownId: { in: drawdownIds } },
    data: {
      paidPrincipal: 0,
      paidInterest: 0,
      paidFee: 0,
      feeDue: 0,
      lateFeeApplied: false,
      status: "PENDING",
      paidAt: null,
    },
  });
}

// --- Paying account -----------------------------------------------------------------------

export function findOwnAccount(companyId: string, accountId: string) {
  return prisma.account.findFirst({ where: { id: accountId, companyId } });
}

export function decrementBalance(accountId: string, amount: number, db: Db = prisma) {
  return db.account.update({ where: { id: accountId }, data: { balance: { decrement: amount } } });
}

export function createTransactionRecord(data: Prisma.TransactionUncheckedCreateInput, db: Db = prisma) {
  return db.transaction.create({ data });
}
