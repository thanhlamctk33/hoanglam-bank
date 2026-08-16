import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { BadRequestError, NotFoundError, PaymentRequiredError, UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { createApprovalRequest } from "../approvals/approval.service";
import { checkLimit } from "../subscription/subscription.service";
import { hasApprovalPower, requireCompanyAdmin } from "../../middleware/companyAdmin";
import { convertCurrency } from "../../shared/fx/fx.service";

const router = Router();
router.use(requireAuth);

async function actorEmail(userId: string | undefined): Promise<string> {
  const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  return user?.email ?? "unknown";
}

/**
 * Budgets are funded by drawn-down credit sitting in the company's cash
 * accounts — a company can't allocate more into budgets than it actually
 * has. Excludes `excludeBudgetId` so editing/resubmitting a budget compares
 * against every *other* active/pending budget. Accounts and other budgets
 * can each be in a different currency than the one being checked, so
 * everything is converted (mock FX rates) into `currency` before comparing.
 */
async function checkBudgetWithinFunds(
  companyId: string,
  newAmount: number,
  currency: string,
  excludeBudgetId?: string
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const [accounts, otherBudgets] = await Promise.all([
    prisma.account.findMany({ where: { companyId }, select: { balance: true, currency: true } }),
    prisma.budget.findMany({
      where: { companyId, status: { in: ["ACTIVE", "PENDING"] }, id: excludeBudgetId ? { not: excludeBudgetId } : undefined },
      select: { amount: true, currency: true },
    }),
  ]);

  const availableFunds = accounts.reduce(
    (sum, a) => sum + convertCurrency(Number(a.balance), a.currency, currency),
    0
  );
  const allocated = otherBudgets.reduce(
    (sum, b) => sum + convertCurrency(Number(b.amount), b.currency, currency),
    0
  );

  if (allocated + newAmount > availableFunds) {
    return {
      allowed: false,
      message: `This budget would push total budgeted funds to ${(allocated + newAmount).toFixed(
        2
      )} ${currency}, above the ${availableFunds.toFixed(2)} ${currency} available in cash (converted at mock FX rates). Draw down more credit or lower the amount.`,
    };
  }
  return { allowed: true };
}

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const budgets = await prisma.budget.findMany({
      where: { companyId: req.companyId },
      include: { owner: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json({ budgets });
  })
);

router.get(
  "/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const budget = await prisma.budget.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
      include: {
        owner: { select: { id: true, name: true } },
        cards: {
          select: { id: true, label: true, type: true, status: true, spendLimit: true, spent: true, currency: true },
        },
      },
    });
    if (!budget) {
      throw new NotFoundError("Budget not found");
    }
    res.json({ budget });
  })
);

const createSchema = z.object({
  name: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().default("USD"),
  period: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]).default("MONTHLY"),
  startDate: z.coerce.date().optional(),
  ownerId: z.string().uuid().optional(),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const limitCheck = await checkLimit(req.companyId!, "budget");
    if (!limitCheck.allowed) {
      throw new PaymentRequiredError(limitCheck.message);
    }

    if (parsed.data.ownerId) {
      const owner = await prisma.user.findFirst({ where: { id: parsed.data.ownerId, companyId: req.companyId } });
      if (!owner) {
        throw new BadRequestError("Owner not found in this company");
      }
    }

    const fundsCheck = await checkBudgetWithinFunds(req.companyId!, parsed.data.amount, parsed.data.currency);
    if (!fundsCheck.allowed) {
      throw new UnprocessableEntityError(fundsCheck.message);
    }

    // Spend policy (Spend > Policies): a hard cap blocks the budget outright;
    // the approval threshold forces this into the approval queue even for a
    // requester who'd normally skip it (Admin/staff). Policy caps are always
    // set in USD, so the budget amount is converted to USD before comparing.
    const policy = await prisma.spendPolicy.findUnique({ where: { companyId: req.companyId! } });
    const amountInUsd = convertCurrency(parsed.data.amount, parsed.data.currency, "USD");
    if (policy?.budgetAmountCap && amountInUsd > Number(policy.budgetAmountCap)) {
      throw new UnprocessableEntityError(
        `Exceeds your company's spend policy — budgets can't be created above ${Number(
          policy.budgetAmountCap
        ).toFixed(2)} USD.`
      );
    }

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    const policyForcesApproval = !!policy?.approvalThreshold && amountInUsd >= Number(policy.approvalThreshold);
    const needsApproval = !hasApprovalPower(actor) || policyForcesApproval;

    const budget = await prisma.budget.create({
      data: { ...parsed.data, status: needsApproval ? "PENDING" : "ACTIVE", companyId: req.companyId! },
      include: { owner: { select: { id: true, name: true } } },
    });

    if (needsApproval) {
      await createApprovalRequest({
        targetType: "BUDGET",
        targetId: budget.id,
        companyId: req.companyId!,
        requesterId: req.userId!,
        metadata: { name: budget.name, amount: budget.amount.toString(), period: budget.period },
      });
    }

    await writeAuditLog({
      action: needsApproval ? "BUDGET_REQUESTED" : "BUDGET_CREATED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Budget",
      targetId: budget.id,
      metadata: { name: budget.name, amount: budget.amount.toString() },
    });

    res.status(201).json({ budget });
  })
);

const updateSchema = z.object({
  amount: z.number().positive(),
});

router.patch(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const budget = await prisma.budget.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!budget) {
      throw new NotFoundError("Budget not found");
    }
    if (budget.status !== "ACTIVE") {
      throw new UnprocessableEntityError("This budget is not active yet");
    }

    const fundsCheck = await checkBudgetWithinFunds(req.companyId!, parsed.data.amount, budget.currency, budget.id);
    if (!fundsCheck.allowed) {
      throw new UnprocessableEntityError(fundsCheck.message);
    }

    const updated = await prisma.budget.update({
      where: { id: budget.id },
      data: { amount: parsed.data.amount },
      include: { owner: { select: { id: true, name: true } } },
    });

    await writeAuditLog({
      action: "BUDGET_LIMIT_CHANGED",
      actorEmail: await actorEmail(req.userId),
      targetType: "Budget",
      targetId: budget.id,
      metadata: { from: budget.amount.toString(), to: parsed.data.amount.toString() },
    });

    res.json({ budget: updated });
  })
);

const statusSchema = z.object({ status: z.enum(["ACTIVE", "FROZEN"]) });

router.patch(
  "/:id/status",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const budget = await prisma.budget.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!budget) {
      throw new NotFoundError("Budget not found");
    }
    if (budget.status !== "ACTIVE" && budget.status !== "FROZEN") {
      throw new UnprocessableEntityError("This budget is not active yet");
    }

    const updated = await prisma.budget.update({
      where: { id: budget.id },
      data: { status: parsed.data.status },
      include: { owner: { select: { id: true, name: true } } },
    });

    await writeAuditLog({
      action: parsed.data.status === "FROZEN" ? "BUDGET_FROZEN" : "BUDGET_UNFROZEN",
      actorEmail: await actorEmail(req.userId),
      targetType: "Budget",
      targetId: budget.id,
      metadata: { name: budget.name },
    });

    res.json({ budget: updated });
  })
);

// Testing only — a hard delete. Blocked while cards are still linked so a
// budget doesn't silently vanish out from under them; unassign/cancel those
// cards first. Also clears out any dangling approval request left behind if
// the budget was still PENDING.
router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const budget = await prisma.budget.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
      include: { cards: { select: { id: true } } },
    });
    if (!budget) {
      throw new NotFoundError("Budget not found");
    }
    if (budget.cards.length > 0) {
      throw new UnprocessableEntityError(
        `"${budget.name}" still has ${budget.cards.length} card${budget.cards.length === 1 ? "" : "s"} linked — unassign them first.`
      );
    }

    await prisma.budget.delete({ where: { id: budget.id } });
    await prisma.approvalRequest.deleteMany({ where: { targetType: "BUDGET", targetId: budget.id } });

    await writeAuditLog({
      action: "BUDGET_DELETED",
      actorEmail: await actorEmail(req.userId),
      targetType: "Budget",
      targetId: budget.id,
      metadata: { name: budget.name, amount: budget.amount.toString() },
    });

    res.status(204).end();
  })
);

const resubmitSchema = z.object({
  name: z.string().min(1),
  amount: z.number().positive(),
});

router.patch(
  "/:id/resubmit",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = resubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const budget = await prisma.budget.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!budget) {
      throw new NotFoundError("Budget not found");
    }
    if (budget.status !== "REJECTED") {
      throw new UnprocessableEntityError("Only rejected requests can be resubmitted");
    }

    const fundsCheck = await checkBudgetWithinFunds(req.companyId!, parsed.data.amount, budget.currency, budget.id);
    if (!fundsCheck.allowed) {
      throw new UnprocessableEntityError(fundsCheck.message);
    }

    const updated = await prisma.budget.update({
      where: { id: budget.id },
      data: {
        name: parsed.data.name,
        amount: parsed.data.amount,
        status: "PENDING",
        rejectionReason: null,
      },
      include: { owner: { select: { id: true, name: true } } },
    });

    const request = await prisma.approvalRequest.findFirst({
      where: { targetType: "BUDGET", targetId: budget.id },
      orderBy: { createdAt: "desc" },
    });
    if (request) {
      await prisma.approvalRequest.update({
        where: { id: request.id },
        data: {
          status: "PENDING",
          reason: null,
          reviewerId: null,
          reviewedAt: null,
          metadata: JSON.stringify({ name: parsed.data.name, amount: parsed.data.amount.toString(), period: budget.period }),
        },
      });
    }

    res.json({ budget: updated });
  })
);

export default router;
