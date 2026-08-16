import { prisma } from "../../lib/prisma";

/** All direct Prisma access for subscription tier/usage lives here — subscription.service.ts never touches `prisma` itself. */
export function findCompanyTier(companyId: string) {
  return prisma.company.findUnique({ where: { id: companyId }, select: { tier: true } });
}

export function countActiveCards(companyId: string) {
  return prisma.card.count({ where: { companyId, status: { in: ["PENDING", "ACTIVE", "FROZEN"] } } });
}

export function countActiveBudgets(companyId: string) {
  return prisma.budget.count({ where: { companyId, status: { in: ["PENDING", "ACTIVE"] } } });
}

export function countClaimsSince(companyId: string, since: Date) {
  return prisma.claim.count({ where: { companyId, submittedAt: { gte: since } } });
}
