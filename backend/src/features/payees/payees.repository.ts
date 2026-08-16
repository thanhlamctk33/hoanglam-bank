import { prisma } from "../../lib/prisma";

/**
 * Thin Prisma wrappers for saved payees — payees.service.ts never touches
 * `prisma` itself.
 */

export function findPayees(companyId: string) {
  return prisma.savedPayee.findMany({ where: { companyId }, orderBy: { nickname: "asc" } });
}

export function findOwnPayee(companyId: string, id: string) {
  return prisma.savedPayee.findFirst({ where: { id, companyId } });
}

export function findPayeeByAccountNumber(companyId: string, accountNumber: string) {
  return prisma.savedPayee.findFirst({ where: { companyId, accountNumber } });
}

export function createPayee(data: { companyId: string; nickname: string; accountNumber: string }) {
  return prisma.savedPayee.create({ data });
}

export function deletePayee(id: string) {
  return prisma.savedPayee.delete({ where: { id } });
}
