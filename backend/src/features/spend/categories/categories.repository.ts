import { prisma } from "../../../lib/prisma";

/**
 * Thin Prisma wrappers for a company's merchant-category list —
 * categories.service.ts never touches `prisma` itself.
 */

export function findCategories(companyId: string) {
  return prisma.merchantCategory.findMany({ where: { companyId }, orderBy: { name: "asc" } });
}

export function findOwnCategory(companyId: string, id: string) {
  return prisma.merchantCategory.findFirst({ where: { id, companyId } });
}

/** Case-insensitive so "Travel" and "travel" can't both exist on one company. */
export function findCategoryByName(companyId: string, name: string) {
  return prisma.merchantCategory.findFirst({
    where: { companyId, name: { equals: name, mode: "insensitive" } },
  });
}

export function createCategory(companyId: string, name: string) {
  return prisma.merchantCategory.create({ data: { companyId, name } });
}

export function createCategories(companyId: string, names: string[]) {
  return prisma.merchantCategory.createMany({
    data: names.map((name) => ({ companyId, name })),
    skipDuplicates: true,
  });
}

export function deleteCategory(id: string) {
  return prisma.merchantCategory.delete({ where: { id } });
}

export function deleteCategories(companyId: string) {
  return prisma.merchantCategory.deleteMany({ where: { companyId } });
}
