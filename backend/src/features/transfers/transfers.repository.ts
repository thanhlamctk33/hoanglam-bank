import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

/**
 * Thin Prisma wrappers for internal/FX/wire transfers and recurring
 * schedules — transfers.service.ts never touches `prisma` itself. Balance
 * updates and transaction-record creation take a `db` argument so the
 * service can run them either standalone or inside a `runInTransaction`
 * block (see bottom of this file).
 */

type Db = Prisma.TransactionClient | typeof prisma;

// --- Recent recipients -----------------------------------------------------------

export function findRecentTransferTransactions(companyId: string) {
  return prisma.transaction.findMany({
    where: {
      type: "DEBIT",
      category: { in: ["Transfer", "FX Transfer", "Wire Transfer"] },
      account: { companyId },
    },
    orderBy: { date: "desc" },
    take: 100,
    select: { category: true, merchant: true, date: true },
  });
}

// --- Accounts ----------------------------------------------------------------------

export function findOwnAccount(companyId: string, accountId: string) {
  return prisma.account.findFirst({ where: { id: accountId, companyId } });
}

export function findAccountByNumber(accountNumber: string) {
  return prisma.account.findUnique({ where: { accountNumber } });
}

export function findAccountById(accountId: string) {
  return prisma.account.findUnique({ where: { id: accountId } });
}

// --- Recurring transfers -------------------------------------------------------------

export function findDueRecurringTransfers(companyId: string) {
  return prisma.recurringTransfer.findMany({
    where: { companyId, active: true, nextRunAt: { lte: new Date() } },
  });
}

export function findRecurringTransfersByCompany(companyId: string) {
  return prisma.recurringTransfer.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}

export function findRecurringTransferById(companyId: string, id: string) {
  return prisma.recurringTransfer.findFirst({ where: { id, companyId } });
}

export function createRecurringTransfer(data: {
  companyId: string;
  fromAccountId: string;
  toAccountNumber: string;
  amount: number;
  note?: string;
  frequency: "WEEKLY" | "MONTHLY";
  nextRunAt: Date;
  createdById: string;
}) {
  return prisma.recurringTransfer.create({ data });
}

export function updateRecurringTransferActive(id: string, active: boolean) {
  return prisma.recurringTransfer.update({ where: { id }, data: { active } });
}

export function rescheduleRecurringTransfer(id: string, nextRunAt: Date) {
  return prisma.recurringTransfer.update({ where: { id }, data: { nextRunAt } });
}

export function markRecurringTransferRun(id: string, nextRunAt: Date) {
  return prisma.recurringTransfer.update({ where: { id }, data: { nextRunAt, lastRunAt: new Date() } });
}

export function deleteRecurringTransfer(id: string) {
  return prisma.recurringTransfer.delete({ where: { id } });
}

// --- Money movement ------------------------------------------------------------------

/** Runs a batch of independent writes atomically — used by the lazy recurring-transfer runner. */
export function runBatch(ops: Prisma.PrismaPromise<unknown>[]) {
  return prisma.$transaction(ops);
}

/** Runs an interactive transaction — used by internal/FX/wire transfers, which branch on fee/overdraft logic mid-transaction. */
export function runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(fn);
}

// `db` defaults to the top-level client (batch-transaction ops just need a
// PrismaPromise) and is only overridden with a `tx` client from inside an
// `runInTransaction` callback.
export function decrementBalance(accountId: string, amount: number, db: Db = prisma) {
  return db.account.update({ where: { id: accountId }, data: { balance: { decrement: amount } } });
}

export function incrementBalance(accountId: string, amount: number, db: Db = prisma) {
  return db.account.update({ where: { id: accountId }, data: { balance: { increment: amount } } });
}

export function createTransactionRecord(data: Prisma.TransactionUncheckedCreateInput, db: Db = prisma) {
  return db.transaction.create({ data });
}
