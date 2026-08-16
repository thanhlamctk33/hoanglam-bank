import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { BadRequestError, LockedError, NotFoundError, UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { getActiveCreditApply, getOrCreatePrimaryAccount } from "../credit/credit.service";
import { applyPaymentToDrawdown, getDrawdownOutstanding, processDueAutoDeductions } from "./repayment.service";
import { canDebit, chargeOverdraftFeeIfNeeded } from "../../shared/overdraft/overdraft.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await processDueAutoDeductions(req.companyId!);
    const repayments = await prisma.repayment.findMany({
      where: { companyId: req.companyId },
      orderBy: { createdAt: "desc" },
    });
    res.json({ repayments });
  })
);

const createSchema = z.object({
  amount: z.number().positive(),
  accountId: z.string().uuid().optional(),
  // Which loan this repayment targets. Omitted (or a REVOLVING drawdown)
  // pays down the pooled outstanding balance directly, same as the
  // original behavior. A scheduled drawdown (AMORTIZING/INTEREST_ONLY/
  // BALLOON) instead applies the payment to its installments waterfall-
  // style — fee, then interest, then principal, oldest due date first.
  drawdownId: z.string().uuid().optional(),
});

router.post(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { amount, accountId, drawdownId } = parsed.data;

    const creditApply = await getActiveCreditApply(req.companyId!);
    if (!creditApply || creditApply.status !== "APPROVED") {
      throw new UnprocessableEntityError("No active credit line to repay.");
    }
    const outstanding = Number(creditApply.drawnAmount);
    if (outstanding <= 0) {
      throw new UnprocessableEntityError("No outstanding balance to repay.");
    }

    let targetDrawdown = null;
    if (drawdownId) {
      targetDrawdown = await prisma.drawdown.findFirst({ where: { id: drawdownId, companyId: req.companyId } });
      if (!targetDrawdown) {
        throw new NotFoundError("Drawdown not found");
      }
    }
    const isScheduled = !!targetDrawdown && targetDrawdown.repaymentMethod !== "REVOLVING";

    const maxPayable = isScheduled ? await getDrawdownOutstanding(targetDrawdown!.id) : outstanding;
    if (maxPayable <= 0) {
      throw new UnprocessableEntityError("No outstanding balance to repay on this loan.");
    }
    if (amount > maxPayable) {
      throw new UnprocessableEntityError(`Amount exceeds outstanding balance (${maxPayable.toFixed(2)}).`);
    }

    let account;
    if (accountId) {
      account = await prisma.account.findFirst({ where: { id: accountId, companyId: req.companyId } });
      if (!account) {
        throw new BadRequestError("Account not found in this company");
      }
    } else {
      account = await getOrCreatePrimaryAccount(req.companyId!);
    }
    if (account.frozen) {
      throw new LockedError("This account is frozen");
    }
    if (!canDebit(account, amount)) {
      throw new UnprocessableEntityError("Insufficient balance in the selected account");
    }

    const repaymentBalanceBefore = Number(account.balance);

    const repayment = await prisma.$transaction(async (tx) => {
      let principalPaid = amount;
      let interestPaid = 0;
      let feePaid = 0;

      if (isScheduled) {
        const waterfall = await applyPaymentToDrawdown(tx, targetDrawdown!.id, amount);
        principalPaid = waterfall.totalPrincipal;
        interestPaid = waterfall.totalInterest;
        feePaid = waterfall.totalFee;
      }

      const updatedCreditApply = await tx.creditApply.update({
        where: { id: creditApply.id },
        data: { drawnAmount: { decrement: principalPaid } },
      });

      await tx.account.update({
        where: { id: account!.id },
        data: { balance: { decrement: amount } },
      });
      await chargeOverdraftFeeIfNeeded(tx, account!, repaymentBalanceBefore, repaymentBalanceBefore - amount);

      await tx.transaction.create({
        data: {
          accountId: account!.id,
          amount,
          currency: account!.currency,
          type: "DEBIT",
          description: "Repayment towards credit line",
          category: "Repayment",
        },
      });

      const created = await tx.repayment.create({
        data: {
          amount,
          companyId: req.companyId!,
          creditApplyId: updatedCreditApply.id,
          drawdownId: targetDrawdown?.id,
          accountId: account!.id,
          requestedById: req.userId!,
          source: "MANUAL",
          principalPaid,
          interestPaid,
          feePaid,
        },
      });

      return created;
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "REPAYMENT_COMPLETED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "CreditApply",
      targetId: creditApply.id,
      metadata: { amount: amount.toString(), drawdownId: targetDrawdown?.id },
    });

    res.status(201).json({ repayment });
  })
);

// Testing/demo convenience: undoes every repayment this company has made —
// deletes all Repayment rows, resets every installment's paid/fee/status
// fields back to a fresh PENDING state (as if just disbursed, including
// clearing any accrued late fee), and recomputes each CreditApply's
// drawnAmount from its drawdowns alone (i.e. as if nothing had been repaid
// yet). Drawdowns themselves are left untouched — unlike /drawdown/reset-demo,
// this only rewinds the repayment side. Account balances and past
// Transactions are left alone, same simplification as the other resets.
router.post(
  "/reset-demo",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const companyId = req.companyId!;

    await prisma.repayment.deleteMany({ where: { companyId } });

    const drawdowns = await prisma.drawdown.findMany({ where: { companyId } });
    const drawdownIds = drawdowns.map((d) => d.id);
    if (drawdownIds.length > 0) {
      await prisma.installment.updateMany({
        where: { drawdownId: { in: drawdownIds } },
        data: {
          paidPrincipal: 0,
          paidInterest: 0,
          paidFee: 0,
          feeDue: 0,
          lateFeeApplied: false,
          status: "PENDING",
          paidAt: null,
        },
      });
    }

    const creditApplies = await prisma.creditApply.findMany({ where: { companyId } });
    for (const apply of creditApplies) {
      const total = drawdowns
        .filter((d) => d.creditApplyId === apply.id)
        .reduce((sum, d) => sum + Number(d.amount), 0);
      await prisma.creditApply.update({ where: { id: apply.id }, data: { drawnAmount: total } });
    }

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "REPAYMENT_DEMO_RESET",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Company",
      targetId: companyId,
    });

    res.json({ ok: true });
  })
);

export default router;
