import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { PLANS, PLAN_ORDER, SubscriptionTier } from "./plans.config";
import { getCompanyTier, getUsage } from "./subscription.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const company = await prisma.company.findUnique({
      where: { id: req.companyId },
      select: { tier: true, subscriptionUpdatedAt: true },
    });
    const tier = (company?.tier as SubscriptionTier) ?? "FREE";
    const usage = await getUsage(req.companyId!);

    res.json({
      tier,
      plan: PLANS[tier],
      usage,
      updatedAt: company?.subscriptionUpdatedAt ?? null,
      plans: PLAN_ORDER.map((t) => PLANS[t]),
    });
  })
);

const changeSchema = z.object({
  tier: z.enum(["FREE", "PRO", "BUSINESS"]),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = changeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const currentTier = await getCompanyTier(req.companyId!);
    const nextTier = parsed.data.tier;

    if (currentTier === nextTier) {
      throw new UnprocessableEntityError(`You're already on the ${PLANS[currentTier].name} plan.`);
    }

    const nextPlan = PLANS[nextTier];
    const usage = await getUsage(req.companyId!);
    const overCards = nextPlan.maxActiveCards !== null && usage.activeCards > nextPlan.maxActiveCards;
    const overBudgets = nextPlan.maxActiveBudgets !== null && usage.activeBudgets > nextPlan.maxActiveBudgets;
    const overClaims = nextPlan.maxClaimsPerMonth !== null && usage.claimsThisMonth > nextPlan.maxClaimsPerMonth;

    if (overCards || overBudgets || overClaims) {
      throw new UnprocessableEntityError(
        `Your current usage exceeds the ${nextPlan.name} plan's limits. Reduce active cards, budgets, or claims before switching down.`
      );
    }

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    const company = await prisma.company.update({
      where: { id: req.companyId },
      data: { tier: nextTier, subscriptionUpdatedAt: new Date() },
      select: { tier: true, subscriptionUpdatedAt: true },
    });

    await writeAuditLog({
      action: "SUBSCRIPTION_CHANGED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Company",
      targetId: req.companyId!,
      metadata: { from: currentTier, to: nextTier },
    });

    res.json({
      tier: company.tier,
      plan: PLANS[company.tier as SubscriptionTier],
      updatedAt: company.subscriptionUpdatedAt,
    });
  })
);

router.post(
  "/reset",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const currentTier = await getCompanyTier(req.companyId!);
    const actor = await prisma.user.findUnique({ where: { id: req.userId } });

    const company = await prisma.company.update({
      where: { id: req.companyId },
      data: { tier: "FREE", subscriptionUpdatedAt: new Date() },
      select: { tier: true, subscriptionUpdatedAt: true },
    });

    await writeAuditLog({
      action: "SUBSCRIPTION_CHANGED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Company",
      targetId: req.companyId!,
      metadata: { from: currentTier, to: "FREE", reason: "test_reset" },
    });

    res.json({
      tier: company.tier,
      plan: PLANS[company.tier as SubscriptionTier],
      updatedAt: company.subscriptionUpdatedAt,
    });
  })
);

export default router;
