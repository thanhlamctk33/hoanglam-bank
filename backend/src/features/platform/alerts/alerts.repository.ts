import { prisma } from "../../../lib/prisma";

/**
 * Thin Prisma wrappers for user-configurable alert rules —
 * alerts.service.ts never touches `prisma` itself.
 */

export function findRulesByCompany(companyId: string) {
  return prisma.alertRule.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}

export function findOwnRule(companyId: string, id: string) {
  return prisma.alertRule.findFirst({ where: { id, companyId } });
}

export function createRule(data: {
  companyId: string;
  type: "LOW_BALANCE" | "LARGE_TRANSACTION";
  threshold: number;
  accountId?: string;
  createdById: string;
}) {
  return prisma.alertRule.create({ data });
}

export function setRuleActive(id: string, active: boolean) {
  return prisma.alertRule.update({ where: { id }, data: { active } });
}

export function deleteRule(id: string) {
  return prisma.alertRule.delete({ where: { id } });
}

export function findOwnAccount(companyId: string, accountId: string) {
  return prisma.account.findFirst({ where: { id: accountId, companyId } });
}
