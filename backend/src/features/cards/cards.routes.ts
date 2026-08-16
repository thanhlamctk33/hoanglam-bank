import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import {
  BadRequestError,
  ForbiddenError,
  LockedError,
  NotFoundError,
  PaymentRequiredError,
  UnauthorizedError,
  UnprocessableEntityError,
  ValidationError,
} from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { createApprovalRequest } from "../approvals/approval.service";
import { checkLimit } from "../subscription/subscription.service";
import { checkPhysicalCardAllowed } from "../kyb/kyb.service";
import { hasApprovalPower, requireCompanyAdmin } from "../../middleware/companyAdmin";
import { convertCurrency } from "../../shared/fx/fx.service";

const router = Router();
router.use(requireAuth);

function generateCardNumber(type: "VIRTUAL" | "PHYSICAL" | "PREPAID") {
  const prefix = type === "VIRTUAL" ? "4" : type === "PHYSICAL" ? "5" : "6";
  let digits = prefix;
  for (let i = 0; i < 15; i++) digits += Math.floor(Math.random() * 10);
  return digits;
}

function generateExpiry() {
  const now = new Date();
  return { expMonth: now.getMonth() + 1, expYear: now.getFullYear() + 5 };
}

function generateCvv() {
  return String(Math.floor(100 + Math.random() * 900));
}

async function verifyPassword(userId: string | undefined, password: string) {
  if (!userId) return false;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return false;
  return bcrypt.compare(password, user.passwordHash);
}

const cardListSelect = {
  id: true,
  label: true,
  last4: true,
  expMonth: true,
  expYear: true,
  type: true,
  status: true,
  rejectionReason: true,
  currency: true,
  spendLimit: true,
  spent: true,
  createdAt: true,
  allowOnline: true,
  allowAtm: true,
  blockedCategories: true,
  owner: { select: { id: true, name: true } },
  budget: { select: { id: true, name: true } },
  account: { select: { id: true, name: true, accountNumber: true, currency: true } },
} as const;

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const cards = await prisma.card.findMany({
      where: { companyId: req.companyId },
      select: cardListSelect,
      orderBy: { createdAt: "asc" },
    });
    res.json({ cards });
  })
);

router.get(
  "/assignable-users",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const users = await prisma.user.findMany({
      where: { companyId: req.companyId, isStaff: false },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    });
    res.json({ users });
  })
);

const createSchema = z.object({
  label: z.string().min(1),
  type: z.enum(["VIRTUAL", "PHYSICAL", "PREPAID"]),
  currency: z.string().default("USD"),
  spendLimit: z.number().positive(),
  ownerId: z.string().uuid().optional(),
  budgetId: z.string().uuid().optional(),
  // Required for PREPAID — the Cash Account the preload amount is drawn
  // from, and that every subsequent purchase on this card debits.
  accountId: z.string().uuid().optional(),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { label, type, spendLimit, ownerId, budgetId, accountId } = parsed.data;
    let { currency } = parsed.data;

    const limitCheck = await checkLimit(req.companyId!, "card");
    if (!limitCheck.allowed) {
      throw new PaymentRequiredError(limitCheck.message);
    }

    if (type === "PHYSICAL") {
      const kybCheck = await checkPhysicalCardAllowed(req.companyId!);
      if (!kybCheck.allowed) {
        throw new ForbiddenError(kybCheck.message);
      }
    }

    let fundingAccount = null;
    if (type === "PREPAID") {
      if (!accountId) {
        throw new BadRequestError("Pick a Cash Account to fund this prepaid card from.");
      }
      fundingAccount = await prisma.account.findFirst({ where: { id: accountId, companyId: req.companyId } });
      if (!fundingAccount) {
        throw new BadRequestError("Account not found in this company");
      }
      if (fundingAccount.frozen) {
        throw new UnprocessableEntityError("This account is frozen and can't fund a prepaid card.");
      }
      // A prepaid card's purchases debit its linked account directly, in that
      // account's own currency — no FX conversion at spend time.
      currency = fundingAccount.currency;
    }

    if (ownerId) {
      const owner = await prisma.user.findFirst({ where: { id: ownerId, companyId: req.companyId } });
      if (!owner) {
        throw new BadRequestError("Owner not found in this company");
      }
    }

    let budget = null;
    if (budgetId && type !== "PREPAID") {
      budget = await prisma.budget.findFirst({ where: { id: budgetId, companyId: req.companyId } });
      if (!budget) {
        throw new BadRequestError("Budget not found in this company");
      }
      if (budget.status === "FROZEN") {
        throw new UnprocessableEntityError(`"${budget.name}" is frozen — unfreeze it before assigning cards.`);
      }

      const existingCards = await prisma.card.findMany({
        where: { budgetId, status: { in: ["ACTIVE", "PENDING"] } },
        select: { spendLimit: true },
      });
      const alreadyAssigned = existingCards.reduce((sum, c) => sum + Number(c.spendLimit), 0);
      if (alreadyAssigned + spendLimit > Number(budget.amount)) {
        throw new UnprocessableEntityError(
          `This card's spend limit would push "${budget.name}" to ${(alreadyAssigned + spendLimit).toFixed(
            2
          )}, above its ${Number(budget.amount).toFixed(2)} budget.`
        );
      }
    }

    // Spend policy (Spend > Policies): a hard cap blocks the card outright;
    // the approval threshold forces this into the approval queue even for a
    // requester who'd normally skip it (Admin/staff). Policy caps are always
    // set in USD, so the card's limit is converted to USD before comparing.
    const policy = await prisma.spendPolicy.findUnique({ where: { companyId: req.companyId! } });
    const spendLimitInUsd = convertCurrency(spendLimit, currency, "USD");
    if (policy?.cardSpendLimitCap && spendLimitInUsd > Number(policy.cardSpendLimitCap)) {
      throw new UnprocessableEntityError(
        `Exceeds your company's spend policy — cards can't be issued with a limit above ${Number(
          policy.cardSpendLimitCap
        ).toFixed(2)} USD.`
      );
    }

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    const policyForcesApproval = !!policy?.approvalThreshold && spendLimitInUsd >= Number(policy.approvalThreshold);
    const needsApproval = !hasApprovalPower(actor) || policyForcesApproval;

    const cardNumber = generateCardNumber(type);
    const { expMonth, expYear } = generateExpiry();

    const card = await prisma.card.create({
      data: {
        label,
        type,
        currency,
        spendLimit,
        cardNumber,
        last4: cardNumber.slice(-4),
        cvv: generateCvv(),
        expMonth,
        expYear,
        status: needsApproval ? "PENDING" : "ACTIVE",
        companyId: req.companyId!,
        ownerId,
        budgetId: type === "PREPAID" ? undefined : budgetId,
        accountId: type === "PREPAID" ? fundingAccount!.id : undefined,
      },
      select: cardListSelect,
    });

    if (needsApproval) {
      await createApprovalRequest({
        targetType: "CARD",
        targetId: card.id,
        companyId: req.companyId!,
        requesterId: req.userId!,
        metadata: { label: card.label, type: card.type, spendLimit: spendLimit.toString(), budget: budget?.name ?? "None" },
      });
    }

    await writeAuditLog({
      action: needsApproval ? "CARD_REQUESTED" : "CARD_ISSUED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Card",
      targetId: card.id,
      metadata: { label: card.label, type: card.type, budget: budget?.name ?? "None" },
    });

    res.status(201).json({ card });
  })
);

const statusSchema = z.object({
  status: z.enum(["ACTIVE", "FROZEN", "CANCELLED"]),
  password: z.string().min(1),
});

router.patch(
  "/:id/status",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    if (!(await verifyPassword(req.userId, parsed.data.password))) {
      throw new UnauthorizedError("Incorrect password");
    }

    const card = await prisma.card.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
    });
    if (!card) {
      throw new NotFoundError("Card not found");
    }
    if (card.status !== "ACTIVE" && card.status !== "FROZEN") {
      throw new UnprocessableEntityError("This card is not active yet");
    }

    const updated = await prisma.card.update({
      where: { id: card.id },
      data: { status: parsed.data.status },
      select: cardListSelect,
    });
    res.json({ card: updated });
  })
);

const resubmitSchema = z.object({
  label: z.string().min(1),
  spendLimit: z.number().positive(),
});

router.patch(
  "/:id/resubmit",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = resubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const card = await prisma.card.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!card) {
      throw new NotFoundError("Card not found");
    }
    if (card.status !== "REJECTED") {
      throw new UnprocessableEntityError("Only rejected requests can be resubmitted");
    }

    if (card.budgetId) {
      const budget = await prisma.budget.findUnique({ where: { id: card.budgetId } });
      if (budget) {
        const existingCards = await prisma.card.findMany({
          where: { budgetId: card.budgetId, status: { in: ["ACTIVE", "PENDING"] }, id: { not: card.id } },
          select: { spendLimit: true },
        });
        const alreadyAssigned = existingCards.reduce((sum, c) => sum + Number(c.spendLimit), 0);
        if (alreadyAssigned + parsed.data.spendLimit > Number(budget.amount)) {
          throw new UnprocessableEntityError(
            `This card's spend limit would push "${budget.name}" to ${(
              alreadyAssigned + parsed.data.spendLimit
            ).toFixed(2)}, above its ${Number(budget.amount).toFixed(2)} budget.`
          );
        }
      }
    }

    const updated = await prisma.card.update({
      where: { id: card.id },
      data: {
        label: parsed.data.label,
        spendLimit: parsed.data.spendLimit,
        status: "PENDING",
        rejectionReason: null,
      },
      select: cardListSelect,
    });

    const request = await prisma.approvalRequest.findFirst({
      where: { targetType: "CARD", targetId: card.id },
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
          metadata: JSON.stringify({ label: parsed.data.label, type: card.type, spendLimit: parsed.data.spendLimit.toString() }),
        },
      });
    }

    res.json({ card: updated });
  })
);

const revealSchema = z.object({
  password: z.string().min(1),
});

router.post(
  "/:id/reveal",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = revealSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    if (!(await verifyPassword(req.userId, parsed.data.password))) {
      throw new UnauthorizedError("Incorrect password");
    }

    const card = await prisma.card.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
      select: { cardNumber: true, cvv: true },
    });
    if (!card) {
      throw new NotFoundError("Card not found");
    }

    res.json({ cardNumber: card.cardNumber, cvv: card.cvv });
  })
);

// Testing only — a hard delete, unlike PATCH /:id/status → CANCELLED which
// just marks a card unusable while keeping its history. Admin-only; also
// clears out any dangling approval request left behind if the card was
// still PENDING.
router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const card = await prisma.card.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!card) {
      throw new NotFoundError("Card not found");
    }

    await prisma.card.delete({ where: { id: card.id } });
    await prisma.approvalRequest.deleteMany({ where: { targetType: "CARD", targetId: card.id } });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "CARD_DELETED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Card",
      targetId: card.id,
      metadata: { label: card.label, type: card.type },
    });

    res.status(204).end();
  })
);

const controlsSchema = z.object({
  allowOnline: z.boolean(),
  allowAtm: z.boolean(),
  blockedCategories: z.array(z.string().min(1).max(40)).max(20),
});

router.patch(
  "/:id/controls",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = controlsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const card = await prisma.card.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!card) {
      throw new NotFoundError("Card not found");
    }

    const updated = await prisma.card.update({
      where: { id: card.id },
      data: {
        allowOnline: parsed.data.allowOnline,
        allowAtm: parsed.data.allowAtm,
        blockedCategories: parsed.data.blockedCategories.length ? JSON.stringify(parsed.data.blockedCategories) : null,
      },
      select: cardListSelect,
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "CARD_CONTROLS_UPDATED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Card",
      targetId: card.id,
      metadata: {
        allowOnline: String(parsed.data.allowOnline),
        allowAtm: String(parsed.data.allowAtm),
        blockedCategories: parsed.data.blockedCategories.join(", "),
      },
    });

    res.json({ card: updated });
  })
);

// This app has no real card network — nothing else ever moves money against
// a card's spend limit. This endpoint exists so allowOnline/allowAtm/
// blockedCategories are real, testable rules rather than settings that do
// nothing. For VIRTUAL/PHYSICAL cards it only touches the card's (and its
// budget's, if assigned) `spent` counters, not an Account balance — those
// were never linked to a specific settlement account, spend limits are
// tracked independently. PREPAID cards are the exception: they're linked to
// a real Account via `accountId`, so a purchase actually debits it too.
const simulatePurchaseSchema = z.object({
  amount: z.number().positive(),
  merchantCategory: z.string().max(40).optional(),
  channel: z.enum(["ONLINE", "IN_STORE", "ATM"]),
});

router.post(
  "/:id/simulate-purchase",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = simulatePurchaseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { amount, merchantCategory, channel } = parsed.data;

    const card = await prisma.card.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!card) {
      throw new NotFoundError("Card not found");
    }
    if (card.status !== "ACTIVE") {
      throw new UnprocessableEntityError(`This card is ${card.status.toLowerCase()} and can't be used.`);
    }
    if (channel === "ONLINE" && !card.allowOnline) {
      throw new ForbiddenError("Online purchases are turned off for this card.");
    }
    if (channel === "ATM" && !card.allowAtm) {
      throw new ForbiddenError("ATM withdrawals are turned off for this card.");
    }

    const blocked: string[] = card.blockedCategories ? JSON.parse(card.blockedCategories) : [];
    if (merchantCategory && blocked.includes(merchantCategory)) {
      throw new ForbiddenError(`Purchases in "${merchantCategory}" are blocked for this card.`);
    }

    const newSpent = Number(card.spent) + amount;
    if (newSpent > Number(card.spendLimit)) {
      throw new UnprocessableEntityError(
        `This purchase would push spend to ${newSpent.toFixed(2)}, above the ${Number(card.spendLimit).toFixed(
          2
        )} ${card.type === "PREPAID" ? "loaded balance" : "monthly limit"}.`
      );
    }

    // PREPAID cards debit their linked Account for real, on top of the usual
    // spendLimit/spent bookkeeping — that's what makes them "real money"
    // rather than an internal-only cap like VIRTUAL/PHYSICAL cards.
    let fundingAccount = null;
    if (card.type === "PREPAID") {
      if (!card.accountId) {
        throw new UnprocessableEntityError("This prepaid card isn't linked to a Cash Account.");
      }
      fundingAccount = await prisma.account.findFirst({ where: { id: card.accountId, companyId: req.companyId } });
      if (!fundingAccount) {
        throw new UnprocessableEntityError("The Cash Account backing this card no longer exists.");
      }
      if (fundingAccount.frozen) {
        throw new LockedError("The Cash Account backing this card is frozen.");
      }
      if (Number(fundingAccount.balance) < amount) {
        throw new UnprocessableEntityError("Insufficient balance in the linked Cash Account.");
      }
    }

    const [updated] = await prisma.$transaction([
      prisma.card.update({
        where: { id: card.id },
        data: { spent: { increment: amount } },
        select: cardListSelect,
      }),
      ...(fundingAccount
        ? [
            prisma.account.update({ where: { id: fundingAccount.id }, data: { balance: { decrement: amount } } }),
            prisma.transaction.create({
              data: {
                accountId: fundingAccount.id,
                amount,
                currency: fundingAccount.currency,
                type: "DEBIT" as const,
                description: `${card.label} •••• ${card.last4}`,
                category: "Card purchase",
                merchantCategory: merchantCategory ?? null,
              },
            }),
          ]
        : []),
    ]);

    if (card.budgetId) {
      await prisma.budget.update({ where: { id: card.budgetId }, data: { spent: { increment: amount } } }).catch(() => {});
    }

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "CARD_PURCHASE_SIMULATED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Card",
      targetId: card.id,
      metadata: { amount: amount.toString(), channel, merchantCategory: merchantCategory ?? "" },
    });

    res.json({ card: updated });
  })
);

export default router;
