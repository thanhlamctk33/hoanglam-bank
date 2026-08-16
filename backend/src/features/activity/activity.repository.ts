import { prisma } from "../../lib/prisma";

/**
 * Thin Prisma wrappers for the company activity feed — activity.service.ts
 * never touches `prisma` itself.
 */

export function findCompanyMembers(companyId: string) {
  return prisma.user.findMany({ where: { companyId }, select: { name: true, email: true } });
}

export function findAuditLogsByActors(emails: string[], take: number) {
  return prisma.auditLog.findMany({
    where: { actorEmail: { in: emails } },
    orderBy: { createdAt: "desc" },
    take,
  });
}
