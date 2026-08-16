import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { ConflictError, NotFoundError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";

const router = Router();
router.use(requireAuth);

// Keep in sync with backend/prisma/seed.ts DEFAULT_MERCHANT_CATEGORIES.
const DEFAULT_MERCHANT_CATEGORIES = ["Travel", "Entertainment", "Software", "Office supplies", "Dining", "Advertising"];

// A company's own merchant-category list, managed at Settings → Categories.
// Currently consumed by Card controls (blocked categories + the
// "Simulate a purchase" merchant-category picker).
router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const categories = await prisma.merchantCategory.findMany({
      where: { companyId: req.companyId },
      orderBy: { name: "asc" },
    });
    res.json({ categories });
  })
);

const createSchema = z.object({
  name: z.string().min(1).max(40),
});

router.post(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const name = parsed.data.name.trim();

    const existing = await prisma.merchantCategory.findFirst({
      where: { companyId: req.companyId, name: { equals: name, mode: "insensitive" } },
    });
    if (existing) {
      throw new ConflictError(`"${name}" already exists`);
    }

    const category = await prisma.merchantCategory.create({
      data: { companyId: req.companyId!, name },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "CATEGORY_CREATED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "MerchantCategory",
      targetId: category.id,
      metadata: { name },
    });

    res.status(201).json({ category });
  })
);

// Testing only — wipes this company's category list and recreates the
// factory defaults. Mirrors the "Reset subscription" pattern in
// routes/subscription.ts.
router.post(
  "/reset",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    await prisma.merchantCategory.deleteMany({ where: { companyId: req.companyId } });
    await prisma.merchantCategory.createMany({
      data: DEFAULT_MERCHANT_CATEGORIES.map((name) => ({ companyId: req.companyId!, name })),
      skipDuplicates: true,
    });

    const categories = await prisma.merchantCategory.findMany({
      where: { companyId: req.companyId },
      orderBy: { name: "asc" },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "CATEGORY_RESET",
      actorEmail: actor?.email ?? "unknown",
      targetType: "MerchantCategory",
      metadata: { reason: "test_reset", categories: DEFAULT_MERCHANT_CATEGORIES },
    });

    res.json({ categories });
  })
);

router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const category = await prisma.merchantCategory.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
    });
    if (!category) {
      throw new NotFoundError("Category not found");
    }

    await prisma.merchantCategory.delete({ where: { id: category.id } });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "CATEGORY_DELETED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "MerchantCategory",
      targetId: category.id,
      metadata: { name: category.name },
    });

    res.status(204).end();
  })
);

export default router;
