import { prisma } from "../../../lib/prisma";

/**
 * Thin Prisma wrappers for company team members — team.service.ts never
 * touches `prisma` itself. Every read that feeds the UI uses `memberSelect`
 * so no password hash can leak into a response.
 */

export const memberSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
} as const;

export function findMembers(companyId: string) {
  return prisma.user.findMany({ where: { companyId }, select: memberSelect, orderBy: { createdAt: "asc" } });
}

export function findOwnMember(companyId: string, id: string) {
  return prisma.user.findFirst({ where: { id, companyId } });
}

export function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export function countAdmins(companyId: string) {
  return prisma.user.count({ where: { companyId, role: "ADMIN" } });
}

export function createMember(data: {
  name: string;
  email: string;
  passwordHash: string;
  role: "ADMIN" | "MEMBER";
  companyId: string;
}) {
  return prisma.user.create({ data, select: memberSelect });
}

export function updateMemberRole(id: string, role: "ADMIN" | "MEMBER") {
  return prisma.user.update({ where: { id }, data: { role }, select: memberSelect });
}

export function deleteMember(id: string) {
  return prisma.user.delete({ where: { id } });
}
