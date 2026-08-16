import { ConflictError, NotFoundError } from "../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../shared/audit/audit.service";
import { DEFAULT_MERCHANT_CATEGORIES } from "./categories.config";
import * as categoriesRepo from "./categories.repository";

/**
 * A company's own merchant-category list, managed at Settings → Categories.
 * Currently consumed by Card controls (blocked categories + the "Simulate a
 * purchase" merchant-category picker).
 *
 * Every route in categories.routes.ts is a thin validate-then-call-this
 * wrapper; all Prisma access goes through categories.repository.ts.
 */

export function listCategories(companyId: string) {
  return categoriesRepo.findCategories(companyId);
}

export async function createCategory(companyId: string, userId: string, rawName: string) {
  const name = rawName.trim();

  const existing = await categoriesRepo.findCategoryByName(companyId, name);
  if (existing) {
    throw new ConflictError(`"${name}" already exists`);
  }

  const category = await categoriesRepo.createCategory(companyId, name);

  await writeAuditLog({
    action: "CATEGORY_CREATED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "MerchantCategory",
    targetId: category.id,
    metadata: { name },
  });

  return category;
}

/** Wipes this company's category list and recreates the factory defaults. */
export async function resetCategories(companyId: string, userId: string) {
  await categoriesRepo.deleteCategories(companyId);
  await categoriesRepo.createCategories(companyId, DEFAULT_MERCHANT_CATEGORIES);

  const categories = await categoriesRepo.findCategories(companyId);

  await writeAuditLog({
    action: "CATEGORY_RESET",
    actorEmail: await resolveActorEmail(userId),
    targetType: "MerchantCategory",
    metadata: { reason: "test_reset", categories: DEFAULT_MERCHANT_CATEGORIES },
  });

  return categories;
}

export async function deleteCategory(companyId: string, id: string, userId: string) {
  const category = await categoriesRepo.findOwnCategory(companyId, id);
  if (!category) {
    throw new NotFoundError("Category not found");
  }

  await categoriesRepo.deleteCategory(category.id);

  await writeAuditLog({
    action: "CATEGORY_DELETED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "MerchantCategory",
    targetId: category.id,
    metadata: { name: category.name },
  });
}
