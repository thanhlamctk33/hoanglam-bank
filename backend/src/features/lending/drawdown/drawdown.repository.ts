import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";

/**
 * Thin Prisma wrappers for credit drawdowns — drawdown.service.ts never
 * touches `prisma` itself. Disbursing funds spans several tables
 * (CreditApply, Account, Transaction, Drawdown, Installment), so those
 * writes take a `db` argument and run inside `runInTransaction`.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** Runs an interactive transaction — a drawdown writes across five tables and must be all-or-nothing. */
export function runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(fn);
}

// --- Drawdowns ---------------------------------------------------------------------

export function findDrawdownsByCompany(companyId: string) {
  return prisma.drawdown.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}

export function findOwnDrawdown(companyId: string, id: string) {
  return prisma.drawdown.findFirst({ where: { id, companyId } });
}

export function findDrawdownIdsByCompany(companyId: string) {
  return prisma.drawdown.findMany({ where: { companyId }, select: { id: true } });
}

export function createDrawdown(data: Prisma.DrawdownUncheckedCreateInput, db: Db = prisma) {
  return db.drawdown.create({ data });
}

export function deleteDrawdownsByCompany(companyId: string) {
  return prisma.drawdown.deleteMany({ where: { companyId } });
}

// --- Installments --------------------------------------------------------------------

export function findInstallmentsForDrawdown(drawdownId: string) {
  return prisma.installment.findMany({ where: { drawdownId }, orderBy: { sequence: "asc" } });
}

export function createInstallments(data: Prisma.InstallmentCreateManyInput[], db: Db = prisma) {
  return db.installment.createMany({ data });
}

export function deleteInstallmentsForDrawdowns(drawdownIds: string[]) {
  return prisma.installment.deleteMany({ where: { drawdownId: { in: drawdownIds } } });
}

// --- Credit line ------------------------------------------------------------------------

export function incrementDrawnAmount(creditApplyId: string, amount: number, db: Db = prisma) {
  return db.creditApply.update({ where: { id: creditApplyId }, data: { drawnAmount: { increment: amount } } });
}

export function resetDrawnAmounts(companyId: string) {
  return prisma.creditApply.updateMany({ where: { companyId }, data: { drawnAmount: 0 } });
}

export function deleteRepaymentsByCompany(companyId: string) {
  return prisma.repayment.deleteMany({ where: { companyId } });
}

// --- Disbursement accounts -----------------------------------------------------------------

export function findOwnAccount(companyId: string, accountId: string) {
  return prisma.account.findFirst({ where: { id: accountId, companyId } });
}

export function findUnfrozenAccountByCurrency(companyId: string, currency: string) {
  return prisma.account.findFirst({
    where: { companyId, currency, frozen: false },
    orderBy: { createdAt: "asc" },
  });
}

export function createAccount(data: {
  name: string;
  currency: string;
  accountNumber: string;
  balance: number;
  companyId: string;
}) {
  return prisma.account.create({ data });
}

export function incrementAccountBalance(accountId: string, amount: number, db: Db = prisma) {
  return db.account.update({ where: { id: accountId }, data: { balance: { increment: amount } } });
}

export function createTransactionRecord(data: Prisma.TransactionUncheckedCreateInput, db: Db = prisma) {
  return db.transaction.create({ data });
}
