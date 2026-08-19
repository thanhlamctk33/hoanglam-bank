import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";

/**
 * Thin Prisma wrappers for interbank lending — no business logic here, see
 * interbank.service.ts. Booking/settling a loan spans several tables, so
 * those go through `runInTransaction` with the `tx` client threaded into the
 * write helpers below.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** Runs an interactive transaction — booking, settling and demo seeding all write across several tables. */
export function runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(fn);
}

// --- Treasury book -------------------------------------------------------------

export function findTreasuryBook() {
  return prisma.treasuryBook.findFirst();
}

export function createTreasuryBook() {
  return prisma.treasuryBook.create({ data: {} });
}

export function adjustTreasuryBalance(bookId: string, delta: number, db: Db = prisma) {
  return db.treasuryBook.update({ where: { id: bookId }, data: { balance: { increment: delta } } });
}

export function findTreasuryTransactions() {
  return prisma.treasuryTransaction.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
}

export function createTreasuryTransaction(data: Prisma.TreasuryTransactionUncheckedCreateInput, db: Db = prisma) {
  return db.treasuryTransaction.create({ data });
}

// --- Counterparty banks ----------------------------------------------------------

export function countCounterparties() {
  return prisma.counterpartyBank.count();
}

export function findCounterparties() {
  return prisma.counterpartyBank.findMany({ orderBy: { createdAt: "desc" } });
}

export function findCounterpartiesByIds(ids: string[]) {
  return prisma.counterpartyBank.findMany({ where: { id: { in: ids } } });
}

export function findCounterpartyById(id: string) {
  return prisma.counterpartyBank.findUnique({ where: { id } });
}

export function findCounterpartyBySwift(swiftCode: string) {
  return prisma.counterpartyBank.findUnique({ where: { swiftCode } });
}

export function createCounterparty(data: Prisma.CounterpartyBankUncheckedCreateInput, db: Db = prisma) {
  return db.counterpartyBank.create({ data });
}

// --- Interbank loans ---------------------------------------------------------------

/** Active loans for a given counterparty, principal only (used to sum exposure). */
export function findActiveLoansByCounterparty(counterpartyId: string) {
  return prisma.interbankLoan.findMany({
    where: { counterpartyId, status: "ACTIVE" },
    select: { principal: true },
  });
}

export function findActiveLoanPrincipals() {
  return prisma.interbankLoan.findMany({ where: { status: "ACTIVE" }, select: { principal: true } });
}

export function findLoans(status?: "ACTIVE" | "SETTLED" | "DEFAULTED") {
  return prisma.interbankLoan.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
  });
}

export function findLoanById(id: string) {
  return prisma.interbankLoan.findUnique({ where: { id } });
}

export function createLoan(data: Prisma.InterbankLoanUncheckedCreateInput, db: Db = prisma) {
  return db.interbankLoan.create({ data });
}

export function settleLoan(id: string, interestReceived: number, db: Db = prisma) {
  return db.interbankLoan.update({
    where: { id },
    data: { status: "SETTLED", settledAt: new Date(), interestReceived },
  });
}

export function defaultLoan(id: string) {
  return prisma.interbankLoan.update({ where: { id }, data: { status: "DEFAULTED", defaultedAt: new Date() } });
}
