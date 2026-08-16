import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import {
  BadRequestError,
  ForbiddenError,
  LockedError,
  NotFoundError,
  UnprocessableEntityError,
  ValidationError,
} from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import {
  getActiveCreditApply,
  availableAmount,
  getOrCreatePrimaryAccount,
  getDrawdownConditions,
  addMonths,
} from "../credit/credit.service";
import { generateInstallmentSchedule, markOverdueInstallments, processDueAutoDeductions } from "../repayment/repayment.service";
import {
  DEFAULT_INTEREST_RATE_PCT,
  DEFAULT_TERM_MONTHS,
  MIN_DRAWDOWN_AMOUNT,
  DRAWDOWN_FEE_PCT,
  MAX_GRACE_MONTHS,
} from "../credit/lending.config";
import { convertCurrency, FX_CURRENCIES } from "../../shared/fx/fx.service";
import { generateUniqueAccountNumber } from "../accounts/accounts.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await processDueAutoDeductions(req.companyId!);
    const drawdowns = await prisma.drawdown.findMany({
      where: { companyId: req.companyId },
      orderBy: { createdAt: "desc" },
    });
    res.json({ drawdowns });
  })
);

// The installment schedule for one drawdown (empty for REVOLVING drawdowns).
// Used both by the Repayment tab (to preview what a targeted repayment will
// cover) and to show the customer their upcoming due dates.
router.get(
  "/:id/installments",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const drawdown = await prisma.drawdown.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!drawdown) {
      throw new NotFoundError("Drawdown not found");
    }
    await markOverdueInstallments(req.companyId!);
    const installments = await prisma.installment.findMany({
      where: { drawdownId: drawdown.id },
      orderBy: { sequence: "asc" },
    });
    res.json({ installments });
  })
);

// Conditions precedent checklist — shown to the customer before they draw
// down, and enforced again server-side in POST / below.
router.get(
  "/conditions",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const conditions = await getDrawdownConditions(req.companyId!);
    res.json({ conditions, feePct: DRAWDOWN_FEE_PCT });
  })
);

const createSchema = z.object({
  amount: z.number().positive(),
  purpose: z.string().max(200).optional(),
  termsAccepted: z.literal(true, {
    errorMap: () => ({ message: "You must confirm the lending terms to draw down funds." }),
  }),
  accountId: z.string().uuid().optional(),
  // Which currency to disburse into. Ignored if accountId is given. If the
  // company doesn't yet have an unfrozen account in this currency, one is
  // opened automatically so a drawdown can land in any supported currency.
  currency: z.enum(FX_CURRENCIES).optional(),
  repaymentMethod: z.enum(["REVOLVING", "AMORTIZING", "INTEREST_ONLY", "BALLOON"]).default("REVOLVING"),
  graceMonths: z.number().int().min(0).max(MAX_GRACE_MONTHS).default(0),
  autoDeduct: z.boolean().default(false),
  autoDeductAccountId: z.string().uuid().optional(),
});

router.post(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { amount, purpose, accountId, currency, repaymentMethod, graceMonths, autoDeduct, autoDeductAccountId } =
      parsed.data;

    if (amount < MIN_DRAWDOWN_AMOUNT) {
      throw new UnprocessableEntityError(`Minimum drawdown is $${MIN_DRAWDOWN_AMOUNT.toLocaleString()}.`);
    }

    if (autoDeduct && repaymentMethod === "REVOLVING") {
      throw new BadRequestError("Auto-deduct requires a scheduled repayment method.");
    }

    let autoDeductAccount = null;
    if (autoDeduct && autoDeductAccountId) {
      autoDeductAccount = await prisma.account.findFirst({ where: { id: autoDeductAccountId, companyId: req.companyId } });
      if (!autoDeductAccount) {
        throw new BadRequestError("Auto-deduct account not found in this company");
      }
    }

    // Conditions precedent — every one of these must hold before funds are
    // released, same checklist the customer sees at GET /drawdown/conditions.
    const conditions = await getDrawdownConditions(req.companyId!);
    if (!conditions.kybApproved) {
      throw new ForbiddenError("Business verification (KYB) must be approved before drawing down funds.");
    }
    if (!conditions.contractSigned) {
      throw new ForbiddenError("Accept the lending contract before drawing down funds.");
    }
    if (!conditions.creditApproved) {
      throw new UnprocessableEntityError("No approved credit line yet. Ask your bank contact to submit a Credit Apply.");
    }
    if (!conditions.noOverduePayments) {
      throw new UnprocessableEntityError(
        "You have an overdue repayment on this credit line — repay it before drawing down further."
      );
    }
    if (!conditions.accountAvailable) {
      throw new UnprocessableEntityError("No unfrozen cash account available to receive funds.");
    }

    const creditApply = await getActiveCreditApply(req.companyId!);
    if (!creditApply || creditApply.status !== "APPROVED") {
      throw new UnprocessableEntityError("No approved credit line yet. Ask your bank contact to submit a Credit Apply.");
    }

    const available = availableAmount(creditApply);
    if (amount > available) {
      throw new UnprocessableEntityError(`Amount exceeds available credit (${available.toFixed(2)}).`);
    }

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });

    let account;
    if (accountId) {
      account = await prisma.account.findFirst({ where: { id: accountId, companyId: req.companyId } });
      if (!account) {
        throw new BadRequestError("Account not found in this company");
      }
      if (account.frozen) {
        throw new LockedError("This account is frozen");
      }
    } else if (currency) {
      account = await prisma.account.findFirst({
        where: { companyId: req.companyId, currency, frozen: false },
        orderBy: { createdAt: "asc" },
      });
      if (!account) {
        const accountNumber = await generateUniqueAccountNumber();
        account = await prisma.account.create({
          data: {
            name: `${currency} account`,
            currency,
            accountNumber,
            balance: 0,
            companyId: req.companyId!,
          },
        });
        await writeAuditLog({
          action: "ACCOUNT_OPENED",
          actorEmail: actor?.email ?? "unknown",
          targetType: "Account",
          targetId: account.id,
          metadata: { name: account.name, currency: account.currency, reason: "drawdown disbursement currency" },
        });
      }
    } else {
      account = await getOrCreatePrimaryAccount(req.companyId!);
    }

    // Every approved credit line has its own offer (rate/tenor) set by the
    // checker at approval time; fall back to the app-wide defaults only for
    // credit lines approved before that offer step existed.
    const interestRatePct = creditApply.offeredInterestRatePct
      ? Number(creditApply.offeredInterestRatePct)
      : DEFAULT_INTEREST_RATE_PCT;
    const termMonths = creditApply.offeredTermMonths ?? DEFAULT_TERM_MONTHS;
    // The credit line itself is always denominated in USD — drawnAmount,
    // fee, and the installment schedule all stay in USD regardless of which
    // currency the funds are actually disbursed into. Only the cash that
    // lands in the target account gets converted, same approach as the FX
    // transfer flow (mock rate table, no real settlement).
    const feeAmount = Math.round(amount * (DRAWDOWN_FEE_PCT / 100) * 100) / 100;
    const netAmount = amount - feeAmount;
    const maturityDate = addMonths(new Date(), termMonths);

    const disbursedGross = Math.round(convertCurrency(amount, "USD", account!.currency) * 100) / 100;
    const disbursedFee = Math.round(convertCurrency(feeAmount, "USD", account!.currency) * 100) / 100;
    const disbursedNet = disbursedGross - disbursedFee;

    const drawdown = await prisma.$transaction(async (tx) => {
      const updatedCreditApply = await tx.creditApply.update({
        where: { id: creditApply.id },
        data: { drawnAmount: { increment: amount } },
      });

      await tx.account.update({
        where: { id: account!.id },
        data: { balance: { increment: disbursedNet } },
      });

      await tx.transaction.create({
        data: {
          accountId: account!.id,
          amount: disbursedGross,
          currency: account!.currency,
          type: "CREDIT",
          description: `Drawdown from credit line (${interestRatePct}% APR, ${termMonths}mo)`,
          category: "Drawdown",
        },
      });

      if (disbursedFee > 0) {
        await tx.transaction.create({
          data: {
            accountId: account!.id,
            amount: disbursedFee,
            currency: account!.currency,
            type: "DEBIT",
            description: `Drawdown fee (${DRAWDOWN_FEE_PCT}%)`,
            category: "Drawdown fee",
          },
        });
      }

      const created = await tx.drawdown.create({
        data: {
          amount,
          interestRatePct,
          termMonths,
          purpose,
          feeAmount,
          maturityDate,
          repaymentMethod,
          graceMonths,
          autoDeduct,
          autoDeductAccountId: autoDeduct ? (autoDeductAccount?.id ?? account!.id) : null,
          companyId: req.companyId!,
          creditApplyId: updatedCreditApply.id,
          accountId: account!.id,
          requestedById: req.userId!,
        },
      });

      if (repaymentMethod !== "REVOLVING") {
        const schedule = generateInstallmentSchedule({
          amount,
          interestRatePct,
          termMonths,
          graceMonths,
          method: repaymentMethod,
          startDate: created.createdAt,
        });
        if (schedule.length > 0) {
          await tx.installment.createMany({
            data: schedule.map((row) => ({
              drawdownId: created.id,
              sequence: row.sequence,
              dueDate: row.dueDate,
              principalDue: row.principalDue,
              interestDue: row.interestDue,
            })),
          });
        }
      }

      return created;
    });

    await writeAuditLog({
      action: "DRAWDOWN_COMPLETED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "CreditApply",
      targetId: creditApply.id,
      metadata: {
        amount: amount.toString(),
        interestRatePct,
        termMonths,
        feeAmount: feeAmount.toString(),
        repaymentMethod,
        graceMonths,
        autoDeduct,
        disbursedCurrency: account!.currency,
        disbursedNet: disbursedNet.toString(),
      },
    });

    res.status(201).json({ drawdown });
  })
);

// Testing/demo convenience: wipes this company's drawdown activity (every
// Drawdown + its Installment schedule, and every Repayment — those no
// longer have anything to apply against) and resets drawnAmount back to 0,
// but — unlike /credit/reset-demo — leaves the CreditApply itself alone, so
// an already-APPROVED credit line stays approved and ready to draw down
// again immediately. Deliberately leaves account balances and past
// Transactions untouched, same simplification as the Credit-level reset.
router.post(
  "/reset-demo",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const companyId = req.companyId!;

    const drawdownIds = (await prisma.drawdown.findMany({ where: { companyId }, select: { id: true } })).map(
      (d) => d.id
    );
    if (drawdownIds.length > 0) {
      await prisma.installment.deleteMany({ where: { drawdownId: { in: drawdownIds } } });
    }
    await prisma.repayment.deleteMany({ where: { companyId } });
    await prisma.drawdown.deleteMany({ where: { companyId } });
    await prisma.creditApply.updateMany({ where: { companyId }, data: { drawnAmount: 0 } });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "DRAWDOWN_DEMO_RESET",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Company",
      targetId: companyId,
    });

    res.json({ ok: true });
  })
);

export default router;
