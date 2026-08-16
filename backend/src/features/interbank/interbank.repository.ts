import { prisma } from "../../lib/prisma";

/**
 * Thin Prisma wrappers for interbank lending — no business logic here, see
 * interbank.service.ts.
 */

export function findTreasuryBook() {
  return prisma.treasuryBook.findFirst();
}

export function createTreasuryBook() {
  return prisma.treasuryBook.create({ data: {} });
}

/** Active loans for a given counterparty, principal only (used to sum exposure). */
export function findActiveLoansByCounterparty(counterpartyId: string) {
  return prisma.interbankLoan.findMany({
    where: { counterpartyId, status: "ACTIVE" },
    select: { principal: true },
  });
}
