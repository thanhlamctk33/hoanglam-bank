import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";

/**
 * Thin Prisma wrappers for the company spend policy —
 * spendPolicy.service.ts never touches `prisma` itself. One row per company,
 * created lazily on first read.
 */

export function findPolicy(companyId: string) {
  return prisma.spendPolicy.findUnique({ where: { companyId } });
}

export function createPolicy(companyId: string) {
  return prisma.spendPolicy.create({ data: { companyId } });
}

export function upsertPolicy(
  companyId: string,
  create: Prisma.SpendPolicyUncheckedCreateInput,
  update: Prisma.SpendPolicyUncheckedUpdateInput
) {
  return prisma.spendPolicy.upsert({ where: { companyId }, create, update });
}
