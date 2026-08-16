import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

/**
 * Thin Prisma wrappers for utility bill payments and QR Pay —
 * payments.service.ts never touches `prisma` itself. Both flows move money
 * across several rows, so the write helpers take a `db` argument and run
 * inside `runInTransaction`.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export function runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(fn);
}

export function findOwnAccount(companyId: string, accountId: string) {
  return prisma.account.findFirst({ where: { id: accountId, companyId } });
}

/** The company's default account, used when the QR code request doesn't name one. */
export function findFirstAccount(companyId: string) {
  return prisma.account.findFirst({ where: { companyId } });
}

export function findAccountByNumber(accountNumber: string) {
  return prisma.account.findUnique({ where: { accountNumber } });
}

export function decrementBalance(accountId: string, amount: number, db: Db = prisma) {
  return db.account.update({ where: { id: accountId }, data: { balance: { decrement: amount } } });
}

export function incrementBalance(accountId: string, amount: number, db: Db = prisma) {
  return db.account.update({ where: { id: accountId }, data: { balance: { increment: amount } } });
}

export function createTransactionRecord(data: Prisma.TransactionUncheckedCreateInput, db: Db = prisma) {
  return db.transaction.create({ data });
}
