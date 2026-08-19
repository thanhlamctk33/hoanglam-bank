import { prisma } from "../../../lib/prisma";

/**
 * Thin Prisma wrappers for the public developer API —
 * publicApi.service.ts never touches `prisma` itself. Every read is scoped
 * to the API key's own company and returns a deliberately narrow field set:
 * this is an external contract, so nothing should leak just because a column
 * was added to the model.
 */

export function findAccounts(companyId: string) {
  return prisma.account.findMany({
    where: { companyId },
    select: { id: true, name: true, type: true, currency: true, balance: true, accountNumber: true, frozen: true },
    orderBy: { createdAt: "asc" },
  });
}

export function findOwnAccount(companyId: string, id: string) {
  return prisma.account.findFirst({ where: { id, companyId } });
}

export function findTransactions(accountId: string, take: number) {
  return prisma.transaction.findMany({ where: { accountId }, orderBy: { date: "desc" }, take });
}
