import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

/**
 * All direct Prisma access for accounts lives here — accounts.service.ts
 * never touches `prisma` itself. Interest accrual has its own pair
 * (interest.repository.ts / interest.service.ts) since it runs on a
 * different trigger.
 */

export function findAccountByNumber(accountNumber: string) {
  return prisma.account.findUnique({ where: { accountNumber } });
}

export function findAccountsByCompany(companyId: string) {
  return prisma.account.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } });
}

export function findOwnAccount(companyId: string, accountId: string) {
  return prisma.account.findFirst({ where: { id: accountId, companyId } });
}

export function findAccountIdsByCompany(companyId: string, accountId?: string) {
  return prisma.account.findMany({
    where: { companyId, ...(accountId ? { id: accountId } : {}) },
    select: { id: true },
  });
}

export function createAccount(data: {
  name: string;
  type: "CHECKING" | "SAVINGS" | "MONEY_MARKET";
  currency: string;
  accountNumber: string;
  balance: number;
  companyId: string;
}) {
  return prisma.account.create({ data });
}

export function updateOverdraftLimit(accountId: string, overdraftLimit: number) {
  return prisma.account.update({ where: { id: accountId }, data: { overdraftLimit } });
}

/** Credits an account and posts the matching CREDIT transaction atomically. */
export function creditAccount(
  accountId: string,
  amount: number,
  currency: string,
  description: string,
  category: string
) {
  return prisma.$transaction([
    prisma.account.update({ where: { id: accountId }, data: { balance: { increment: amount } } }),
    prisma.transaction.create({
      data: { accountId, amount, currency, type: "CREDIT", description, category },
    }),
  ]);
}

// --- Transactions / statements / reports ---------------------------------------

export function findTransactions(where: Prisma.TransactionWhereInput, skip: number, take: number) {
  return prisma.transaction.findMany({ where, orderBy: { date: "desc" }, skip, take });
}

export function countTransactions(where: Prisma.TransactionWhereInput) {
  return prisma.transaction.count({ where });
}

export function sumTransactions(where: Prisma.TransactionWhereInput) {
  return prisma.transaction.aggregate({ where, _sum: { amount: true } });
}

export function findTransactionsInRange(accountId: string, from: Date, to: Date) {
  return prisma.transaction.findMany({
    where: { accountId, date: { gte: from, lt: to } },
    orderBy: { date: "asc" },
  });
}

export function findTransactionsForReport(accountIds: string[], since: Date) {
  return prisma.transaction.findMany({
    where: { accountId: { in: accountIds }, date: { gte: since } },
    select: { amount: true, type: true, category: true, date: true },
  });
}

export function findDistinctTransactionCategories(accountId: string) {
  return prisma.transaction.findMany({
    where: { accountId, category: { not: null } },
    select: { category: true },
    distinct: ["category"],
    orderBy: { category: "asc" },
  });
}

// --- Demo/sandbox helpers (see accounts.demo.routes.ts) ---------------------------

export function createTransactions(data: Prisma.TransactionCreateManyInput[]) {
  return prisma.transaction.createMany({ data });
}

export function applyNetEffect(accountId: string, netEffect: number) {
  return prisma.account.update({ where: { id: accountId }, data: { balance: { increment: netEffect } } });
}

export function runBatch(ops: Prisma.PrismaPromise<unknown>[]) {
  return prisma.$transaction(ops);
}

export function deleteTransactionsForAccounts(accountIds: string[]) {
  return prisma.transaction.deleteMany({ where: { accountId: { in: accountIds } } });
}

export function zeroBalances(companyId: string) {
  return prisma.account.updateMany({ where: { companyId }, data: { balance: 0 } });
}
