import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";

const router = Router();
router.use(requireAuth);

// One SpendPolicy row per company, created lazily the first time anyone
// loads Spend > Policies — there's nothing to configure until then, so a
// migration-time backfill isn't needed.
router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    let policy = await prisma.spendPolicy.findUnique({ where: { companyId: req.companyId! } });
    if (!policy) {
      policy = await prisma.spendPolicy.create({ data: { companyId: req.companyId! } });
    }
    res.json({ policy });
  })
);

const updateSchema = z.object({
  cardSpendLimitCap: z.number().positive().nullable(),
  budgetAmountCap: z.number().positive().nullable(),
  approvalThreshold: z.number().positive().nullable(),
  claimFlagLimit: z.number().positive(),
  // Velocity/fraud controls: velocityMaxCount null (or omitted) means no
  // limit — same "null = unlimited" convention as the other caps above.
  velocityMaxCount: z.number().int().positive().nullable().optional(),
  velocityWindowMinutes: z.number().int().positive().max(1440).optional(),
});

router.patch(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const {
      cardSpendLimitCap,
      budgetAmountCap,
      approvalThreshold,
      claimFlagLimit,
      velocityMaxCount,
      velocityWindowMinutes,
    } = parsed.data;

    const policy = await prisma.spendPolicy.upsert({
      where: { companyId: req.companyId! },
      create: {
        companyId: req.companyId!,
        cardSpendLimitCap,
        budgetAmountCap,
        approvalThreshold,
        claimFlagLimit,
        velocityMaxCount: velocityMaxCount ?? null,
        ...(velocityWindowMinutes !== undefined ? { velocityWindowMinutes } : {}),
        updatedById: req.userId,
      },
      update: {
        cardSpendLimitCap,
        budgetAmountCap,
        approvalThreshold,
        claimFlagLimit,
        ...(velocityMaxCount !== undefined ? { velocityMaxCount } : {}),
        ...(velocityWindowMinutes !== undefined ? { velocityWindowMinutes } : {}),
        updatedById: req.userId,
      },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "SPEND_POLICY_UPDATED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "SpendPolicy",
      targetId: policy.id,
      metadata: {
        cardSpendLimitCap: cardSpendLimitCap?.toString() ?? "none",
        budgetAmountCap: budgetAmountCap?.toString() ?? "none",
        approvalThreshold: approvalThreshold?.toString() ?? "none",
        claimFlagLimit: claimFlagLimit.toString(),
        velocityMaxCount: velocityMaxCount?.toString() ?? "none",
      },
    });

    res.json({ policy });
  })
);

const DEFAULT_CLAIM_FLAG_LIMIT = 500;

// Restores this company's spend policy to the out-of-the-box defaults: no
// card/budget caps, no forced approval threshold, claim flag limit back to
// $500. A real settings action (not a testing-only helper) — an Admin might
// use this after experimenting with limits to undo everything at once
// instead of clearing each field by hand.
router.post(
  "/reset",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const policy = await prisma.spendPolicy.upsert({
      where: { companyId: req.companyId! },
      create: {
        companyId: req.companyId!,
        cardSpendLimitCap: null,
        budgetAmountCap: null,
        approvalThreshold: null,
        claimFlagLimit: DEFAULT_CLAIM_FLAG_LIMIT,
        velocityMaxCount: null,
        updatedById: req.userId,
      },
      update: {
        cardSpendLimitCap: null,
        budgetAmountCap: null,
        approvalThreshold: null,
        claimFlagLimit: DEFAULT_CLAIM_FLAG_LIMIT,
        velocityMaxCount: null,
        velocityWindowMinutes: 60,
        updatedById: req.userId,
      },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "SPEND_POLICY_RESET_TO_DEFAULT",
      actorEmail: actor?.email ?? "unknown",
      targetType: "SpendPolicy",
      targetId: policy.id,
    });

    res.json({ policy });
  })
);

export default router;
