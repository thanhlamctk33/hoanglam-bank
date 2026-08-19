import { BadRequestError, ForbiddenError, LockedError, NotFoundError, UnprocessableEntityError } from "../../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../../shared/audit/audit.service";
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
} from "../credit/lending.config";
import { convertCurrency, FX_CURRENCIES } from "../../../shared/fx/fx.service";
import { generateUniqueAccountNumber } from "../../banking/accounts/accounts.service";
import * as drawdownRepo from "./drawdown.repository";

/**
 * Business logic for credit drawdowns — every route in drawdown.routes.ts
 * is a thin validate-then-call-this wrapper. All Prisma access goes through
 * drawdown.repository.ts.
 */

export async function listDrawdowns(companyId: string) {
  await processDueAutoDeductions(companyId);
  return drawdownRepo.findDrawdownsByCompany(companyId);
}

// The installment schedule for one drawdown (empty for REVOLVING drawdowns).
// Used both by the Repayment tab (to preview what a targeted repayment will
// cover) and to show the customer their upcoming due dates.
export async function listInstallments(companyId: string, drawdownId: string) {
  const drawdown = await drawdownRepo.findOwnDrawdown(companyId, drawdownId);
  if (!drawdown) {
    throw new NotFoundError("Drawdown not found");
  }
  await markOverdueInstallments(companyId);
  return drawdownRepo.findInstallmentsForDrawdown(drawdown.id);
}

/**
 * Resolves which cash account receives the funds: an explicitly chosen one,
 * the company's first unfrozen account in the requested currency (opening
 * one if none exists yet), or the primary account as a fallback.
 */
async function resolveDisbursementAccount(
  companyId: string,
  userId: string,
  accountId?: string,
  currency?: (typeof FX_CURRENCIES)[number]
) {
  if (accountId) {
    const account = await drawdownRepo.findOwnAccount(companyId, accountId);
    if (!account) {
      throw new BadRequestError("Account not found in this company");
    }
    if (account.frozen) {
      throw new LockedError("This account is frozen");
    }
    return account;
  }

  if (currency) {
    const existing = await drawdownRepo.findUnfrozenAccountByCurrency(companyId, currency);
    if (existing) return existing;

    const accountNumber = await generateUniqueAccountNumber();
    const created = await drawdownRepo.createAccount({
      name: `${currency} account`,
      currency,
      accountNumber,
      balance: 0,
      companyId,
    });
    await writeAuditLog({
      action: "ACCOUNT_OPENED",
      actorEmail: await resolveActorEmail(userId),
      targetType: "Account",
      targetId: created.id,
      metadata: { name: created.name, currency: created.currency, reason: "drawdown disbursement currency" },
    });
    return created;
  }

  return getOrCreatePrimaryAccount(companyId);
}

/**
 * Conditions precedent — every one of these must hold before funds are
 * released, same checklist the customer sees at GET /drawdown/conditions.
 */
async function assertDrawdownConditions(companyId: string) {
  const conditions = await getDrawdownConditions(companyId);
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
}

export async function getConditions(companyId: string) {
  const conditions = await getDrawdownConditions(companyId);
  return { conditions, feePct: DRAWDOWN_FEE_PCT };
}

export interface CreateDrawdownParams {
  amount: number;
  purpose?: string;
  accountId?: string;
  currency?: (typeof FX_CURRENCIES)[number];
  repaymentMethod: "REVOLVING" | "AMORTIZING" | "INTEREST_ONLY" | "BALLOON";
  graceMonths: number;
  autoDeduct: boolean;
  autoDeductAccountId?: string;
}

export async function createDrawdown(companyId: string, userId: string, params: CreateDrawdownParams) {
  const { amount, purpose, accountId, currency, repaymentMethod, graceMonths, autoDeduct, autoDeductAccountId } = params;

  if (amount < MIN_DRAWDOWN_AMOUNT) {
    throw new UnprocessableEntityError(`Minimum drawdown is $${MIN_DRAWDOWN_AMOUNT.toLocaleString()}.`);
  }

  if (autoDeduct && repaymentMethod === "REVOLVING") {
    throw new BadRequestError("Auto-deduct requires a scheduled repayment method.");
  }

  let autoDeductAccount = null;
  if (autoDeduct && autoDeductAccountId) {
    autoDeductAccount = await drawdownRepo.findOwnAccount(companyId, autoDeductAccountId);
    if (!autoDeductAccount) {
      throw new BadRequestError("Auto-deduct account not found in this company");
    }
  }

  await assertDrawdownConditions(companyId);

  const creditApply = await getActiveCreditApply(companyId);
  if (!creditApply || creditApply.status !== "APPROVED") {
    throw new UnprocessableEntityError("No approved credit line yet. Ask your bank contact to submit a Credit Apply.");
  }

  const available = availableAmount(creditApply);
  if (amount > available) {
    throw new UnprocessableEntityError(`Amount exceeds available credit (${available.toFixed(2)}).`);
  }

  const account = await resolveDisbursementAccount(companyId, userId, accountId, currency);

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
  const maturityDate = addMonths(new Date(), termMonths);

  const disbursedGross = Math.round(convertCurrency(amount, "USD", account.currency) * 100) / 100;
  const disbursedFee = Math.round(convertCurrency(feeAmount, "USD", account.currency) * 100) / 100;
  const disbursedNet = disbursedGross - disbursedFee;

  const drawdown = await drawdownRepo.runInTransaction(async (tx) => {
    const updatedCreditApply = await drawdownRepo.incrementDrawnAmount(creditApply.id, amount, tx);

    await drawdownRepo.incrementAccountBalance(account.id, disbursedNet, tx);

    await drawdownRepo.createTransactionRecord(
      {
        accountId: account.id,
        amount: disbursedGross,
        currency: account.currency,
        type: "CREDIT",
        description: `Drawdown from credit line (${interestRatePct}% APR, ${termMonths}mo)`,
        category: "Drawdown",
      },
      tx
    );

    if (disbursedFee > 0) {
      await drawdownRepo.createTransactionRecord(
        {
          accountId: account.id,
          amount: disbursedFee,
          currency: account.currency,
          type: "DEBIT",
          description: `Drawdown fee (${DRAWDOWN_FEE_PCT}%)`,
          category: "Drawdown fee",
        },
        tx
      );
    }

    const created = await drawdownRepo.createDrawdown(
      {
        amount,
        interestRatePct,
        termMonths,
        purpose,
        feeAmount,
        maturityDate,
        repaymentMethod,
        graceMonths,
        autoDeduct,
        autoDeductAccountId: autoDeduct ? (autoDeductAccount?.id ?? account.id) : null,
        companyId,
        creditApplyId: updatedCreditApply.id,
        accountId: account.id,
        requestedById: userId,
      },
      tx
    );

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
        await drawdownRepo.createInstallments(
          schedule.map((installment) => ({
            drawdownId: created.id,
            sequence: installment.sequence,
            dueDate: installment.dueDate,
            principalDue: installment.principalDue,
            interestDue: installment.interestDue,
          })),
          tx
        );
      }
    }

    return created;
  });

  await writeAuditLog({
    action: "DRAWDOWN_COMPLETED",
    actorEmail: await resolveActorEmail(userId),
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
      disbursedCurrency: account.currency,
      disbursedNet: disbursedNet.toString(),
    },
  });

  return drawdown;
}

/**
 * Wipes this company's drawdown activity (every Drawdown + its Installment
 * schedule, and every Repayment — those no longer have anything to apply
 * against) and resets drawnAmount back to 0, but — unlike
 * /credit/reset-demo — leaves the CreditApply itself alone, so an
 * already-APPROVED credit line stays approved and ready to draw down again
 * immediately. Deliberately leaves account balances and past Transactions
 * untouched, same simplification as the Credit-level reset.
 */
export async function resetDemoData(companyId: string, userId: string) {
  const drawdownIds = (await drawdownRepo.findDrawdownIdsByCompany(companyId)).map((drawdown) => drawdown.id);
  if (drawdownIds.length > 0) {
    await drawdownRepo.deleteInstallmentsForDrawdowns(drawdownIds);
  }
  await drawdownRepo.deleteRepaymentsByCompany(companyId);
  await drawdownRepo.deleteDrawdownsByCompany(companyId);
  await drawdownRepo.resetDrawnAmounts(companyId);

  await writeAuditLog({
    action: "DRAWDOWN_DEMO_RESET",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Company",
    targetId: companyId,
  });
}
