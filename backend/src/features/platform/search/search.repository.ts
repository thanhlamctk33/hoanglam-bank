import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";

/**
 * Thin Prisma wrappers for global search — search.service.ts never touches
 * `prisma` itself. Every query is capped at RESULT_LIMIT and returns only
 * the fields the Topbar dropdown renders.
 */

/** Case-insensitive "contains" filter shared by every entity below. */
export function containsFilter(searchTerm: string): Prisma.StringFilter {
  return { contains: searchTerm, mode: "insensitive" };
}

export function searchTransactions(companyId: string, contains: Prisma.StringFilter, take: number) {
  return prisma.transaction.findMany({
    where: {
      account: { companyId },
      OR: [{ description: contains }, { merchant: contains }, { category: contains }],
    },
    orderBy: { date: "desc" },
    take,
    select: {
      id: true,
      description: true,
      merchant: true,
      category: true,
      amount: true,
      currency: true,
      type: true,
      date: true,
      accountId: true,
    },
  });
}

export function searchCards(companyId: string, contains: Prisma.StringFilter, take: number) {
  return prisma.card.findMany({
    where: { companyId, label: contains },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, label: true, status: true, last4: true },
  });
}

export function searchBudgets(companyId: string, contains: Prisma.StringFilter, take: number) {
  return prisma.budget.findMany({
    where: { companyId, name: contains },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, name: true, status: true, amount: true, currency: true },
  });
}

export function searchBills(companyId: string, contains: Prisma.StringFilter, take: number) {
  return prisma.bill.findMany({
    where: { companyId, vendor: contains },
    orderBy: { dueDate: "desc" },
    take,
    select: { id: true, vendor: true, status: true, amount: true, currency: true, dueDate: true },
  });
}

export function searchClaims(companyId: string, contains: Prisma.StringFilter, take: number) {
  return prisma.claim.findMany({
    where: { companyId, title: contains },
    orderBy: { submittedAt: "desc" },
    take,
    select: { id: true, title: true, status: true, amount: true, currency: true },
  });
}
