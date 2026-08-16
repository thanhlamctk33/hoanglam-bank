import { prisma } from "../../lib/prisma";

/** All direct Prisma access for KYB status lives here — kyb.service.ts never touches `prisma` itself. */
export function findCompanyKybStatus(companyId: string) {
  return prisma.company.findUnique({ where: { id: companyId }, select: { kybStatus: true } });
}
