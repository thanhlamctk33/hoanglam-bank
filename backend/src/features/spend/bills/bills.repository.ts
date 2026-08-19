import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";

/**
 * Thin Prisma wrappers for bills — bills.service.ts never touches `prisma`
 * itself. Paying a bill touches Bill/Account/Transaction together, so those
 * writes take a `db` argument and run inside `runInTransaction`, both for a
 * manual payment and for the lazy autopay runner.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** Runs an interactive transaction — manual bill payment branches on the overdraft fee mid-transaction. */
export function runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(fn);
}

// --- Bills ---------------------------------------------------------------------

export function findBillsByCompany(companyId: string) {
  return prisma.bill.findMany({ where: { companyId }, orderBy: { dueDate: "asc" } });
}

export function findOwnBill(companyId: string, id: string) {
  return prisma.bill.findFirst({ where: { id, companyId } });
}

export function findDueAutopayBills(companyId: string) {
  return prisma.bill.findMany({
    where: {
      companyId,
      status: { in: ["UNPAID", "OVERDUE"] },
      dueDate: { lte: new Date() },
      autopayAccountId: { not: null },
    },
  });
}

export function createBill(data: {
  vendor: string;
  amount: number;
  currency: string;
  dueDate: Date;
  companyId: string;
}) {
  return prisma.bill.create({ data });
}

export function updateBillStatus(id: string, status: "UNPAID" | "PAID" | "OVERDUE", db: Db = prisma) {
  return db.bill.update({ where: { id }, data: { status } });
}

export function updateBillAutopayAccount(id: string, autopayAccountId: string | null) {
  return prisma.bill.update({ where: { id }, data: { autopayAccountId } });
}

export function deleteBill(id: string) {
  return prisma.bill.delete({ where: { id } });
}

// --- Accounts / transactions ------------------------------------------------------

export function findAccountById(id: string) {
  return prisma.account.findUnique({ where: { id } });
}

export function findOwnAccount(companyId: string, id: string) {
  return prisma.account.findFirst({ where: { id, companyId } });
}

export function createTransactionRecord(data: Prisma.TransactionUncheckedCreateInput, db: Db = prisma) {
  return db.transaction.create({ data });
}
