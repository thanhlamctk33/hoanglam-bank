import { Prisma, RepaymentMethod } from "@prisma/client";
import { addMonths, getActiveCreditApply, getOrCreatePrimaryAccount } from "../credit/credit.service";
import { LATE_FEE_PCT, BALLOON_PRINCIPAL_PCT } from "../credit/lending.config";
import { BadRequestError, LockedError, NotFoundError, UnprocessableEntityError } from "../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../shared/audit/audit.service";
import { canDebit, chargeOverdraftFeeIfNeeded } from "../../shared/overdraft/overdraft.service";
import {
  findDrawdownIdsByCompany,
  findOverdueInstallments,
  updateInstallment,
  findUnpaidInstallmentsByDrawdown,
  findAutoDeductDrawdowns,
  findDueInstallments,
  findAccountForAutoDeduct,
  runInTransaction,
  findRepaymentsByCompany,
  createRepayment,
  deleteRepaymentsByCompany,
  findOwnDrawdown,
  findDrawdownsByCompany,
  findCreditAppliesByCompany,
  decrementDrawnAmount,
  setDrawnAmount,
  resetInstallments,
  findOwnAccount,
  decrementBalance,
  createTransactionRecord,
} from "./repayment.repository";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface InstallmentPlanRow {
  sequence: number;
  dueDate: Date;
  principalDue: number;
  interestDue: number;
}

/**
 * Builds the Installment schedule for a new drawdown. REVOLVING returns an
 * empty schedule (the original free-form repay-anytime behavior). The other
 * three methods bill over `termMonths - graceMonths` periods, one per
 * month, starting `graceMonths` after `startDate`:
 *
 * - AMORTIZING: standard equal-payment (EMI) schedule — interest declines
 *   and principal grows each period as the balance is paid down.
 * - INTEREST_ONLY ("bullet"): interest-only every period, full principal
 *   due alongside the last interest payment.
 * - BALLOON: a portion of principal (BALLOON_PRINCIPAL_PCT) is deferred to
 *   the final installment; the rest amortizes normally over the term.
 *
 * All interest accrues on the outstanding balance at interestRatePct/12
 * per period. Rounding is mopped up onto the final installment so the
 * schedule always sums exactly to the drawdown amount.
 */
export function generateInstallmentSchedule(params: {
  amount: number;
  interestRatePct: number;
  termMonths: number;
  graceMonths: number;
  method: RepaymentMethod;
  startDate: Date;
}): InstallmentPlanRow[] {
  const { amount, interestRatePct, termMonths, graceMonths, method, startDate } = params;
  if (method === "REVOLVING") return [];

  const payPeriods = Math.max(1, termMonths - graceMonths);
  const monthlyRate = interestRatePct / 100 / 12;
  const dueDateFor = (n: number) => addMonths(startDate, graceMonths + n);
  const schedule: InstallmentPlanRow[] = [];

  if (method === "AMORTIZING") {
    let balance = amount;
    const payment =
      monthlyRate > 0
        ? (balance * monthlyRate * Math.pow(1 + monthlyRate, payPeriods)) /
          (Math.pow(1 + monthlyRate, payPeriods) - 1)
        : balance / payPeriods;
    for (let n = 1; n <= payPeriods; n++) {
      const interestDue = round2(balance * monthlyRate);
      let principalDue = round2(payment - interestDue);
      if (n === payPeriods) principalDue = round2(balance);
      balance = round2(balance - principalDue);
      schedule.push({ sequence: n, dueDate: dueDateFor(n), principalDue, interestDue });
    }
  } else if (method === "INTEREST_ONLY") {
    for (let n = 1; n <= payPeriods; n++) {
      const interestDue = round2(amount * monthlyRate);
      const principalDue = n === payPeriods ? amount : 0;
      schedule.push({ sequence: n, dueDate: dueDateFor(n), principalDue, interestDue });
    }
  } else if (method === "BALLOON") {
    const balloonAmount = round2(amount * (BALLOON_PRINCIPAL_PCT / 100));
    const amortizedAmount = round2(amount - balloonAmount);
    let balance = amount; // interest accrues on the full outstanding balance, balloon included
    const amortizedPayment =
      monthlyRate > 0
        ? (amortizedAmount * monthlyRate * Math.pow(1 + monthlyRate, payPeriods)) /
          (Math.pow(1 + monthlyRate, payPeriods) - 1)
        : amortizedAmount / payPeriods;
    for (let n = 1; n <= payPeriods; n++) {
      const interestDue = round2(balance * monthlyRate);
      let principalDue = Math.max(0, round2(amortizedPayment - interestDue));
      if (n === payPeriods) principalDue = round2(balance); // remaining balance, including the balloon
      balance = round2(balance - principalDue);
      schedule.push({ sequence: n, dueDate: dueDateFor(n), principalDue, interestDue });
    }
  }

  return schedule;
}

/**
 * Marks any installment past its due date (and not yet fully paid) as
 * OVERDUE, and — the first time only, tracked via lateFeeApplied — adds a
 * one-off late fee (LATE_FEE_PCT of the remaining amount owed) onto its
 * feeDue so it's collected via the normal waterfall before interest or
 * principal.
 */
export async function markOverdueInstallments(companyId: string): Promise<void> {
  // Installment has no Prisma relation back to Drawdown (this schema avoids
  // @relation FKs — see Drawdown/CreditApply/Repayment, which use raw id
  // columns too), so the company scope is resolved as a two-step lookup
  // instead of a nested relation filter.
  const drawdownIds = (await findDrawdownIdsByCompany(companyId)).map((d) => d.id);
  if (drawdownIds.length === 0) return;

  const overdue = await findOverdueInstallments(drawdownIds, new Date());

  for (const inst of overdue) {
    const data: Prisma.InstallmentUpdateInput = { status: "OVERDUE" };
    if (!inst.lateFeeApplied) {
      const owed =
        Number(inst.principalDue) -
        Number(inst.paidPrincipal) +
        (Number(inst.interestDue) - Number(inst.paidInterest));
      const lateFee = round2(owed * (LATE_FEE_PCT / 100));
      data.feeDue = round2(Number(inst.feeDue) + lateFee);
      data.lateFeeApplied = true;
    }
    await updateInstallment(inst.id, data);
  }
}

export interface WaterfallResult {
  totalPrincipal: number;
  totalInterest: number;
  totalFee: number;
  leftover: number;
}

/**
 * Applies a payment to a drawdown's unpaid installments, oldest-first,
 * waterfall-style within each one: fee owed, then interest owed, then
 * principal owed. Any amount left over after every installment is fully
 * paid (an over-payment) is returned as `leftover` for the caller to decide
 * what to do with. Must run inside the same transaction as the rest of the
 * repayment so it stays atomic with the account debit.
 */
export async function applyPaymentToDrawdown(
  tx: Prisma.TransactionClient,
  drawdownId: string,
  amount: number
): Promise<WaterfallResult> {
  const installments = await tx.installment.findMany({
    where: { drawdownId, status: { not: "PAID" } },
    orderBy: { sequence: "asc" },
  });

  let remaining = amount;
  let totalPrincipal = 0;
  let totalInterest = 0;
  let totalFee = 0;

  for (const inst of installments) {
    if (remaining <= 0) break;

    const feeOwed = round2(Number(inst.feeDue) - Number(inst.paidFee));
    const interestOwed = round2(Number(inst.interestDue) - Number(inst.paidInterest));
    const principalOwed = round2(Number(inst.principalDue) - Number(inst.paidPrincipal));

    const feePay = Math.min(remaining, feeOwed);
    remaining = round2(remaining - feePay);
    const interestPay = Math.min(remaining, interestOwed);
    remaining = round2(remaining - interestPay);
    const principalPay = Math.min(remaining, principalOwed);
    remaining = round2(remaining - principalPay);

    if (feePay > 0 || interestPay > 0 || principalPay > 0) {
      const newPaidFee = round2(Number(inst.paidFee) + feePay);
      const newPaidInterest = round2(Number(inst.paidInterest) + interestPay);
      const newPaidPrincipal = round2(Number(inst.paidPrincipal) + principalPay);
      const fullyPaid =
        newPaidFee >= Number(inst.feeDue) &&
        newPaidInterest >= Number(inst.interestDue) &&
        newPaidPrincipal >= Number(inst.principalDue);

      await tx.installment.update({
        where: { id: inst.id },
        data: {
          paidFee: newPaidFee,
          paidInterest: newPaidInterest,
          paidPrincipal: newPaidPrincipal,
          status: fullyPaid ? "PAID" : "PARTIAL",
          paidAt: fullyPaid ? new Date() : inst.paidAt,
        },
      });

      totalFee = round2(totalFee + feePay);
      totalInterest = round2(totalInterest + interestPay);
      totalPrincipal = round2(totalPrincipal + principalPay);
    }
  }

  return { totalPrincipal, totalInterest, totalFee, leftover: remaining };
}

/**
 * The maximum a single repayment can be applied to a scheduled drawdown
 * right now: everything remaining across every unpaid installment (past
 * due or not — overpaying prepays future installments' principal, same as
 * a real facility accepting early repayment).
 */
export async function getDrawdownOutstanding(drawdownId: string): Promise<number> {
  const installments = await findUnpaidInstallmentsByDrawdown(drawdownId);
  return round2(
    installments.reduce(
      (sum: number, i: (typeof installments)[number]) =>
        sum +
        (Number(i.principalDue) - Number(i.paidPrincipal)) +
        (Number(i.interestDue) - Number(i.paidInterest)) +
        (Number(i.feeDue) - Number(i.paidFee)),
      0
    )
  );
}

/**
 * No background worker exists in this app (same pattern as recurring
 * transfers) — auto-deduct drawdowns are settled lazily, whenever a
 * relevant page is loaded. For each drawdown with autoDeduct on, first
 * accrues any late fees that are now due, then — if the designated account
 * can cover everything currently owed — debits it in one go and applies
 * the waterfall. If funds are insufficient, the installment is left
 * OVERDUE (already fee-accrued) and retried on the next visit.
 */
export async function processDueAutoDeductions(companyId: string): Promise<void> {
  await markOverdueInstallments(companyId);

  const drawdowns = await findAutoDeductDrawdowns(companyId);

  for (const drawdown of drawdowns) {
    const dueInstallments = await findDueInstallments(drawdown.id, new Date());
    if (dueInstallments.length === 0) continue;

    const totalDue = round2(
      dueInstallments.reduce(
        (sum: number, i: (typeof dueInstallments)[number]) =>
          sum +
          (Number(i.principalDue) - Number(i.paidPrincipal)) +
          (Number(i.interestDue) - Number(i.paidInterest)) +
          (Number(i.feeDue) - Number(i.paidFee)),
        0
      )
    );
    if (totalDue <= 0) continue;

    const account = await findAccountForAutoDeduct(drawdown.autoDeductAccountId ?? drawdown.accountId, companyId);
    if (!account || account.frozen || !canDebit(account, totalDue)) continue;

    const autoDeductBalanceBefore = Number(account.balance);

    await runInTransaction(async (tx) => {
      const waterfall = await applyPaymentToDrawdown(tx, drawdown.id, totalDue);
      await decrementBalance(account.id, totalDue, tx);
      await chargeOverdraftFeeIfNeeded(tx, account, autoDeductBalanceBefore, autoDeductBalanceBefore - totalDue);
      await createTransactionRecord(
        {
          accountId: account.id,
          amount: totalDue,
          currency: account.currency,
          type: "DEBIT",
          description: "Auto-deduct repayment",
          category: "Repayment",
        },
        tx
      );
      await decrementDrawnAmount(drawdown.creditApplyId, waterfall.totalPrincipal, tx);
      await createRepayment(
        {
          amount: totalDue,
          companyId,
          creditApplyId: drawdown.creditApplyId,
          drawdownId: drawdown.id,
          accountId: account.id,
          requestedById: drawdown.requestedById,
          source: "AUTO_DEDUCT",
          principalPaid: waterfall.totalPrincipal,
          interestPaid: waterfall.totalInterest,
          feePaid: waterfall.totalFee,
        },
        tx
      );
    });

    await writeAuditLog({
      action: "AUTO_DEDUCT_REPAYMENT",
      actorEmail: "system:auto-deduct",
      targetType: "Drawdown",
      targetId: drawdown.id,
      metadata: { amount: totalDue.toString() },
    });
  }
}

// ---------------------------------------------------------------------------
// Route-facing operations — repayment.routes.ts is a thin validate-then-call
// wrapper over everything below.
// ---------------------------------------------------------------------------

export async function listRepayments(companyId: string) {
  await processDueAutoDeductions(companyId);
  return findRepaymentsByCompany(companyId);
}

export interface MakeRepaymentParams {
  amount: number;
  accountId?: string;
  /**
   * Which loan this repayment targets. Omitted (or a REVOLVING drawdown)
   * pays down the pooled outstanding balance directly. A scheduled drawdown
   * (AMORTIZING/INTEREST_ONLY/BALLOON) instead applies the payment to its
   * installments waterfall-style — fee, then interest, then principal,
   * oldest due date first.
   */
  drawdownId?: string;
}

export async function makeRepayment(companyId: string, userId: string, params: MakeRepaymentParams) {
  const { amount, accountId, drawdownId } = params;

  const creditApply = await getActiveCreditApply(companyId);
  if (!creditApply || creditApply.status !== "APPROVED") {
    throw new UnprocessableEntityError("No active credit line to repay.");
  }
  const outstanding = Number(creditApply.drawnAmount);
  if (outstanding <= 0) {
    throw new UnprocessableEntityError("No outstanding balance to repay.");
  }

  let targetDrawdown = null;
  if (drawdownId) {
    targetDrawdown = await findOwnDrawdown(companyId, drawdownId);
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
    account = await findOwnAccount(companyId, accountId);
    if (!account) {
      throw new BadRequestError("Account not found in this company");
    }
  } else {
    account = await getOrCreatePrimaryAccount(companyId);
  }
  if (account.frozen) {
    throw new LockedError("This account is frozen");
  }
  if (!canDebit(account, amount)) {
    throw new UnprocessableEntityError("Insufficient balance in the selected account");
  }

  const repaymentBalanceBefore = Number(account.balance);
  const payingAccount = account;

  const repayment = await runInTransaction(async (tx) => {
    let principalPaid = amount;
    let interestPaid = 0;
    let feePaid = 0;

    if (isScheduled) {
      const waterfall = await applyPaymentToDrawdown(tx, targetDrawdown!.id, amount);
      principalPaid = waterfall.totalPrincipal;
      interestPaid = waterfall.totalInterest;
      feePaid = waterfall.totalFee;
    }

    const updatedCreditApply = await decrementDrawnAmount(creditApply.id, principalPaid, tx);

    await decrementBalance(payingAccount.id, amount, tx);
    await chargeOverdraftFeeIfNeeded(tx, payingAccount, repaymentBalanceBefore, repaymentBalanceBefore - amount);

    await createTransactionRecord(
      {
        accountId: payingAccount.id,
        amount,
        currency: payingAccount.currency,
        type: "DEBIT",
        description: "Repayment towards credit line",
        category: "Repayment",
      },
      tx
    );

    return createRepayment(
      {
        amount,
        companyId,
        creditApplyId: updatedCreditApply.id,
        drawdownId: targetDrawdown?.id,
        accountId: payingAccount.id,
        requestedById: userId,
        source: "MANUAL",
        principalPaid,
        interestPaid,
        feePaid,
      },
      tx
    );
  });

  await writeAuditLog({
    action: "REPAYMENT_COMPLETED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "CreditApply",
    targetId: creditApply.id,
    metadata: { amount: amount.toString(), drawdownId: targetDrawdown?.id },
  });

  return repayment;
}

/**
 * Undoes every repayment this company has made — deletes all Repayment rows,
 * resets every installment's paid/fee/status fields back to a fresh PENDING
 * state (as if just disbursed, including clearing any accrued late fee), and
 * recomputes each CreditApply's drawnAmount from its drawdowns alone (i.e. as
 * if nothing had been repaid yet). Drawdowns themselves are left untouched —
 * unlike /drawdown/reset-demo, this only rewinds the repayment side. Account
 * balances and past Transactions are left alone, same simplification as the
 * other resets.
 */
export async function resetDemoData(companyId: string, userId: string) {
  await deleteRepaymentsByCompany(companyId);

  const drawdowns = await findDrawdownsByCompany(companyId);
  const drawdownIds = drawdowns.map((d) => d.id);
  if (drawdownIds.length > 0) {
    await resetInstallments(drawdownIds);
  }

  const creditApplies = await findCreditAppliesByCompany(companyId);
  for (const apply of creditApplies) {
    const total = drawdowns.filter((d) => d.creditApplyId === apply.id).reduce((sum, d) => sum + Number(d.amount), 0);
    await setDrawnAmount(apply.id, total);
  }

  await writeAuditLog({
    action: "REPAYMENT_DEMO_RESET",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Company",
    targetId: companyId,
  });
}
