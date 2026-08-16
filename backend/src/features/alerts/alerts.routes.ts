import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";

const router = Router();
router.use(requireAuth);

// User-configurable alert thresholds, on top of the fixed low-balance/large-
// transaction heuristics elsewhere in the app. AlertRule has no Prisma
// relation to Account (raw accountId column, null = applies to every
// account on the company) — same no-relation convention as the other
// financial models in this codebase.
router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const rules = await prisma.alertRule.findMany({
      where: { companyId: req.companyId },
      orderBy: { createdAt: "desc" },
    });
    res.json({ rules });
  })
);

const createSchema = z.object({
  type: z.enum(["LOW_BALANCE", "LARGE_TRANSACTION"]),
  threshold: z.number().positive(),
  accountId: z.string().uuid().optional(),
});

router.post(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { type, threshold, accountId } = parsed.data;

    if (accountId) {
      const account = await prisma.account.findFirst({ where: { id: accountId, companyId: req.companyId } });
      if (!account) {
        throw new NotFoundError("Account not found");
      }
    }

    const rule = await prisma.alertRule.create({
      data: {
        companyId: req.companyId!,
        type,
        threshold,
        accountId,
        createdById: req.userId!,
      },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "ALERT_RULE_CREATED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "AlertRule",
      targetId: rule.id,
      metadata: { type, threshold: threshold.toString(), accountId: accountId ?? "all" },
    });

    res.status(201).json({ rule });
  })
);

const updateSchema = z.object({ active: z.boolean() });

router.patch(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const rule = await prisma.alertRule.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!rule) {
      throw new NotFoundError("Alert rule not found");
    }
    const updated = await prisma.alertRule.update({ where: { id: rule.id }, data: { active: parsed.data.active } });
    res.json({ rule: updated });
  })
);

router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const rule = await prisma.alertRule.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!rule) {
      throw new NotFoundError("Alert rule not found");
    }
    await prisma.alertRule.delete({ where: { id: rule.id } });
    res.status(204).end();
  })
);

export default router;
