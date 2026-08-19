import { Account } from "@prisma/client";
import { BadRequestError, ForbiddenError, LockedError, NotFoundError, TooManyRequestsError, UnprocessableEntityError } from "../../../errors/AppError";
import { checkTransactionAllowed } from "../../compliance/kyb/kyb.service";
import { assertOtp } from "../../../shared/otp/otp.service";
import { convertCurrency, FX_CURRENCIES, FX_FEE_PCT } from "../../../shared/fx/fx.service";
import { writeAuditLog, resolveActorEmail } from "../../../shared/audit/audit.service";
import { canDebit, chargeOverdraftFeeIfNeeded, debitWithinOverdraftLimit } from "../../../shared/overdraft/overdraft.service";
import { checkVelocity, flagIfAnomalous } from "../../../shared/fraud/fraud.service";
import { PLANS } from "../../platform/subscription/plans.config";
import { getCompanyTier } from "../../platform/subscription/subscription.service";
import * as transfersRepo from "./transfers.repository";

/**
 * Business logic + money-movement orchestration for internal/FX/wire
 * transfers and recurring schedules — every route in transfers.routes.ts is
 * a thin validate-then-call-this wrapper. All Prisma access goes through
 * transfers.repository.ts.
 */

/**
 * Applies the company's plan-based transferDiscountPct to a base transfer
 * fee. Used for both the FX percentage fee and the flat wire fee — same
 * discount mechanism as the bill-payment discount in features/payments,
 * just applied to the fee instead of the payment amount.
 */
export function applyTransferDiscount(baseFeeAmount: number, transferDiscountPct: number) {
  const discountAmount = Math.round(baseFeeAmount * (transferDiscountPct / 100) * 100) / 100;
  const feeAmount = Math.round((baseFeeAmount - discountAmount) * 100) / 100;
  return { baseFeeAmount, discountAmount, feeAmount };
}

/**
 * Loads a company's own account by id, or throws if it doesn't exist or is
 * frozen. The first gate every outbound money-movement route (internal, FX,
 * wire transfer) runs before doing anything else with the source account.
 */
async function loadOwnAccount(companyId: string, accountId: string) {
  const account = await transfersRepo.findOwnAccount(companyId, accountId);
  if (!account) {
    throw new NotFoundError("Source account not found");
  }
  if (account.frozen) {
    throw new LockedError("This account is frozen");
  }
  return account;
}

/**
 * Runs the checks that gate whether money can actually leave `account`
 * right now: available balance, velocity limit, and the company's KYB
 * transaction limit. Shared by internal, FX, and wire transfers.
 *
 * `debitAmount` is what must actually be available in the account —
 * principal plus any fee, for FX/wire. `kybAmount` is what counts against
 * the company's KYB transaction limit, which (matching the pre-existing
 * per-route behavior) is the transfer principal only, excluding fees; it
 * defaults to `debitAmount` for internal transfers, which have no fee.
 */
async function authorizeDebit(account: Account, companyId: string, debitAmount: number, kybAmount = debitAmount) {
  if (!canDebit(account, debitAmount)) {
    throw new UnprocessableEntityError("Insufficient balance");
  }

  const velocityCheck = await checkVelocity(companyId, account.id);
  if (!velocityCheck.ok) {
    throw new TooManyRequestsError(velocityCheck.error);
  }

  const kybCheck = await checkTransactionAllowed(companyId, kybAmount);
  if (!kybCheck.allowed) {
    throw new ForbiddenError(kybCheck.message);
  }
}

// --- Recent recipients -----------------------------------------------------------

// Recent recipients: derived from the account's own transaction history rather
// than a dedicated table, so there's nothing new to migrate. Internal transfers
// store the destination account number as `merchant`; FX transfers store
// "<name> (<account>) → <currency>"; wire transfers store "<name> (<account>) @ <bank>" —
// all three formats can be parsed back out.
export async function listRecentRecipients(companyId: string) {
  const transferTransactions = await transfersRepo.findRecentTransferTransactions(companyId);

  type Recipient =
    | { type: "internal"; accountNumber: string; lastUsedAt: string }
    | { type: "fx"; recipientName: string; recipientAccount: string; targetCurrency: string; lastUsedAt: string }
    | { type: "wire"; recipientName: string; recipientAccount: string; bankName: string; lastUsedAt: string };

  const seenRecipientKeys = new Set<string>();
  const recipients: Recipient[] = [];

  for (const transaction of transferTransactions) {
    if (recipients.length >= 5) break;
    if (!transaction.merchant) continue;

    if (transaction.category === "Transfer") {
      const key = `internal:${transaction.merchant}`;
      if (seenRecipientKeys.has(key)) continue;
      seenRecipientKeys.add(key);
      recipients.push({ type: "internal", accountNumber: transaction.merchant, lastUsedAt: transaction.date.toISOString() });
    } else if (transaction.category === "FX Transfer") {
      const match = /^(.*) \(([^)]+)\) → (\w+)$/.exec(transaction.merchant);
      if (!match) continue;
      const [, recipientName, recipientAccount, targetCurrency] = match;
      const key = `fx:${recipientAccount}`;
      if (seenRecipientKeys.has(key)) continue;
      seenRecipientKeys.add(key);
      recipients.push({ type: "fx", recipientName, recipientAccount, targetCurrency, lastUsedAt: transaction.date.toISOString() });
    } else if (transaction.category === "Wire Transfer") {
      const match = /^(.*) \(([^)]+)\) @ (.+)$/.exec(transaction.merchant);
      if (!match) continue;
      const [, recipientName, recipientAccount, bankName] = match;
      const key = `wire:${recipientAccount}`;
      if (seenRecipientKeys.has(key)) continue;
      seenRecipientKeys.add(key);
      recipients.push({ type: "wire", recipientName, recipientAccount, bankName, lastUsedAt: transaction.date.toISOString() });
    }
  }

  return recipients;
}

// --- Recurring transfers -------------------------------------------------------------

function advanceSchedule(date: Date, frequency: "WEEKLY" | "MONTHLY"): Date {
  const next = new Date(date);
  if (frequency === "WEEKLY") {
    next.setDate(next.getDate() + 7);
  } else {
    next.setMonth(next.getMonth() + 1);
  }
  return next;
}

// No background worker exists in this app, so recurring transfers run
// lazily: whenever GET /transfers/recurring is called, each active schedule
// with nextRunAt <= now executes ONE transfer (reusing the same
// money-movement logic as POST /), then nextRunAt is rolled forward to the
// next future occurrence. If a schedule was due multiple times since the
// last visit, this intentionally fires only once rather than bulk-catching
// up every missed occurrence, to avoid a surprise burst of transfers.
//
// The destination account number doesn't have to belong to a LamBank
// account — same as FX/Wire transfers, it can be any account number. If it
// happens to match a LamBank account, this posts a normal two-leg internal
// transfer (debit + credit). Otherwise it's treated as an external payout:
// only the source account is debited, same as a wire leaving the bank.
export async function processDueRecurringTransfers(companyId: string) {
  const due = await transfersRepo.findDueRecurringTransfers(companyId);

  for (const schedule of due) {
    const fromAccount = await transfersRepo.findAccountById(schedule.fromAccountId);
    const toAccount = await transfersRepo.findAccountByNumber(schedule.toAccountNumber);
    const amount = Number(schedule.amount);

    let nextRunAt = advanceSchedule(schedule.nextRunAt, schedule.frequency);
    while (nextRunAt <= new Date()) {
      nextRunAt = advanceSchedule(nextRunAt, schedule.frequency);
    }

    if (
      !fromAccount ||
      fromAccount.companyId !== companyId ||
      fromAccount.frozen ||
      (toAccount && toAccount.id === fromAccount.id) ||
      !canDebit(fromAccount, amount)
    ) {
      // Can't run this occurrence (frozen, insufficient funds, destination is
      // the same account, ...) — skip it and try again next occurrence
      // rather than blocking the whole loop or erroring with nobody to show
      // it to.
      await transfersRepo.rescheduleRecurringTransfer(schedule.id, nextRunAt);
      continue;
    }

    const kybCheck = await checkTransactionAllowed(companyId, amount);
    if (!kybCheck.allowed) {
      await transfersRepo.rescheduleRecurringTransfer(schedule.id, nextRunAt);
      continue;
    }

    const description = schedule.note?.trim() || `Recurring transfer to ${schedule.toAccountNumber}`;

    // An interactive transaction rather than a batch of independent writes:
    // the debit has to be guarded against the account being drained between
    // the canDebit() check above and this write, and that guard needs to be
    // able to abandon the rest of the occurrence.
    const debitedSuccessfully = await transfersRepo.runInTransaction(async (tx) => {
      const debitResult = await debitWithinOverdraftLimit(tx, fromAccount.id, amount);
      if (!debitResult.ok) {
        return false;
      }

      await transfersRepo.createTransactionRecord(
        {
          accountId: fromAccount.id,
          amount,
          currency: fromAccount.currency,
          type: "DEBIT",
          description,
          category: "Transfer",
          merchant: schedule.toAccountNumber,
        },
        tx
      );

      if (toAccount) {
        await transfersRepo.incrementBalance(toAccount.id, amount, tx);
        await transfersRepo.createTransactionRecord(
          {
            accountId: toAccount.id,
            amount,
            currency: toAccount.currency,
            type: "CREDIT",
            description: schedule.note?.trim() || `Transfer from ${fromAccount.accountNumber}`,
            category: "Transfer",
            merchant: fromAccount.accountNumber,
          },
          tx
        );
      }

      await chargeOverdraftFeeIfNeeded(tx, fromAccount, debitResult.balanceBefore, debitResult.balanceAfter);
      await transfersRepo.markRecurringTransferRun(schedule.id, nextRunAt);
      return true;
    });

    if (!debitedSuccessfully) {
      // Someone else spent the money first — skip this occurrence the same way
      // the pre-flight checks above do, rather than erroring with nobody to
      // show it to.
      await transfersRepo.rescheduleRecurringTransfer(schedule.id, nextRunAt);
      continue;
    }

    await writeAuditLog({
      action: "RECURRING_TRANSFER_RUN",
      actorEmail: "system:recurring",
      targetType: "RecurringTransfer",
      targetId: schedule.id,
      metadata: { amount: amount.toString(), toAccountNumber: schedule.toAccountNumber, external: !toAccount },
    });
  }
}

export async function listRecurringTransfers(companyId: string) {
  await processDueRecurringTransfers(companyId);
  return transfersRepo.findRecurringTransfersByCompany(companyId);
}

export interface CreateRecurringTransferParams {
  fromAccountId: string;
  toAccountNumber: string;
  amount: number;
  note?: string;
  frequency: "WEEKLY" | "MONTHLY";
  startDate?: string;
}

export async function createRecurringTransfer(companyId: string, userId: string, params: CreateRecurringTransferParams) {
  const { fromAccountId, toAccountNumber, amount, note, frequency, startDate } = params;

  const fromAccount = await transfersRepo.findOwnAccount(companyId, fromAccountId);
  if (!fromAccount) {
    throw new NotFoundError("Source account not found");
  }
  // The destination doesn't have to be a LamBank account — same as FX/Wire
  // transfers, any account number is accepted. If it matches a LamBank
  // account when the schedule runs, money moves internally (two legs);
  // otherwise it's treated as an external payout (one leg, like a wire).
  const toAccount = await transfersRepo.findAccountByNumber(toAccountNumber);
  if (toAccount && toAccount.id === fromAccount.id) {
    throw new BadRequestError("Cannot schedule a transfer to the same account");
  }

  const schedule = await transfersRepo.createRecurringTransfer({
    companyId,
    fromAccountId,
    toAccountNumber,
    amount,
    note,
    frequency,
    nextRunAt: startDate ? new Date(startDate) : new Date(),
    createdById: userId,
  });

  await writeAuditLog({
    action: "RECURRING_TRANSFER_CREATED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "RecurringTransfer",
    targetId: schedule.id,
    metadata: { amount: amount.toString(), frequency, toAccountNumber },
  });

  return schedule;
}

export async function setRecurringTransferActive(companyId: string, id: string, active: boolean) {
  const schedule = await transfersRepo.findRecurringTransferById(companyId, id);
  if (!schedule) {
    throw new NotFoundError("Recurring transfer not found");
  }
  return transfersRepo.updateRecurringTransferActive(schedule.id, active);
}

export async function deleteRecurringTransfer(companyId: string, id: string) {
  const schedule = await transfersRepo.findRecurringTransferById(companyId, id);
  if (!schedule) {
    throw new NotFoundError("Recurring transfer not found");
  }
  await transfersRepo.deleteRecurringTransfer(schedule.id);
}

// --- Internal transfer -----------------------------------------------------------------

// Internal transfer accepts either a typed account number or a scanned/uploaded
// QR payload (format "HLBQR:<accountNumber>") — the two entry methods from the
// Transfer page's "Account number" / "Upload QR" tabs both resolve here.
export interface InternalTransferParams {
  fromAccountId: string;
  toAccountNumber?: string;
  qrPayload?: string;
  amount: number;
  note?: string;
  merchantCategory?: string;
  otp: string;
}

export async function executeInternalTransfer(companyId: string, userId: string, params: InternalTransferParams) {
  const { fromAccountId, amount, note, merchantCategory } = params;

  assertOtp(params.otp);

  let toAccountNumber = params.toAccountNumber;
  if (!toAccountNumber && params.qrPayload) {
    // Payload is either "HLBQR:<accountNumber>" or, when the merchant
    // requested a specific amount, "HLBQR:<accountNumber>|<amount>|<note>" —
    // only the account number segment is trusted server-side; the amount is
    // always taken from the request body, never from the scanned code.
    const match = /^HLBQR:(.+)$/.exec(params.qrPayload.trim());
    if (!match) {
      throw new BadRequestError("That QR code isn't a LamBank pay code");
    }
    toAccountNumber = match[1].split("|")[0];
  }
  if (!toAccountNumber) {
    throw new BadRequestError("Missing recipient account number");
  }

  const fromAccount = await loadOwnAccount(companyId, fromAccountId);

  const toAccount = await transfersRepo.findAccountByNumber(toAccountNumber);
  if (!toAccount) {
    throw new NotFoundError("Destination account number not found");
  }
  if (toAccount.id === fromAccount.id) {
    throw new BadRequestError("Cannot transfer to the same account");
  }

  await authorizeDebit(fromAccount, companyId, amount);

  const description = note?.trim() || `Transfer to ${toAccount.accountNumber}`;

  const result = await transfersRepo.runInTransaction(async (tx) => {
    // Re-checks the overdraft limit as part of the UPDATE, so a concurrent
    // transfer that drained the account after authorizeDebit() ran can't
    // result in both going through. See shared/overdraft/overdraft.service.ts.
    const debitResult = await debitWithinOverdraftLimit(tx, fromAccount.id, amount);
    if (!debitResult.ok) {
      throw new UnprocessableEntityError("Insufficient balance");
    }
    await transfersRepo.incrementBalance(toAccount.id, amount, tx);
    await chargeOverdraftFeeIfNeeded(tx, fromAccount, debitResult.balanceBefore, debitResult.balanceAfter);

    const debit = await transfersRepo.createTransactionRecord(
      {
        accountId: fromAccount.id,
        amount,
        currency: fromAccount.currency,
        type: "DEBIT",
        description,
        category: "Transfer",
        merchant: toAccount.accountNumber,
        merchantCategory: merchantCategory || undefined,
      },
      tx
    );
    await transfersRepo.createTransactionRecord(
      {
        accountId: toAccount.id,
        amount,
        currency: toAccount.currency,
        type: "CREDIT",
        description: note?.trim() || `Transfer from ${fromAccount.accountNumber}`,
        category: "Transfer",
        merchant: fromAccount.accountNumber,
        merchantCategory: merchantCategory || undefined,
      },
      tx
    );

    return debit;
  });

  await flagIfAnomalous(result.id, fromAccount.id, amount);

  await writeAuditLog({
    action: "TRANSFER_COMPLETED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Transaction",
    targetId: result.id,
    metadata: { amount: amount.toString(), currency: fromAccount.currency, toAccountNumber: toAccount.accountNumber },
  });

  return result;
}

// --- FX transfer -----------------------------------------------------------------------

// FX transfer: money leaves the bank entirely (recipient isn't necessarily a
// LamBank account), converted at a mock rate for display purposes.
export interface FxTransferParams {
  fromAccountId: string;
  targetCurrency: (typeof FX_CURRENCIES)[number];
  amount: number;
  recipientName: string;
  recipientAccount: string;
  note?: string;
  merchantCategory?: string;
  otp: string;
}

export async function executeFxTransfer(companyId: string, userId: string, params: FxTransferParams) {
  const { fromAccountId, targetCurrency, amount, recipientName, recipientAccount, note, merchantCategory } = params;

  assertOtp(params.otp);

  const fromAccount = await loadOwnAccount(companyId, fromAccountId);
  const tier = await getCompanyTier(companyId);
  const plan = PLANS[tier];
  const { baseFeeAmount, discountAmount, feeAmount } = applyTransferDiscount(
    Math.round(((amount * FX_FEE_PCT) / 100) * 100) / 100,
    plan.transferDiscountPct
  );

  await authorizeDebit(fromAccount, companyId, amount + feeAmount, amount);

  const convertedAmount = convertCurrency(amount, fromAccount.currency, targetCurrency);
  const description =
    (note?.trim() ? `${note.trim()} — ` : "") +
    `FX transfer to ${recipientName} (${recipientAccount}): ${convertedAmount.toFixed(2)} ${targetCurrency}`;
  const feeDescription =
    discountAmount > 0
      ? `FX transfer fee (${plan.transferDiscountPct}% ${plan.name} plan discount applied)`
      : "FX transfer fee";
  const transaction = await transfersRepo.runInTransaction(async (tx) => {
    // Principal and fee are debited in one guarded statement so the pair can
    // never straddle the overdraft floor, then recorded as the two separate
    // transaction rows the statement view expects.
    const debitResult = await debitWithinOverdraftLimit(tx, fromAccount.id, amount + feeAmount);
    if (!debitResult.ok) {
      throw new UnprocessableEntityError("Insufficient balance");
    }
    const debit = await transfersRepo.createTransactionRecord(
      {
        accountId: fromAccount.id,
        amount,
        currency: fromAccount.currency,
        type: "DEBIT",
        description,
        category: "FX Transfer",
        merchant: `${recipientName} (${recipientAccount}) → ${targetCurrency}`,
        merchantCategory: merchantCategory || undefined,
      },
      tx
    );
    if (feeAmount > 0) {
      await transfersRepo.createTransactionRecord(
        {
          accountId: fromAccount.id,
          amount: feeAmount,
          currency: fromAccount.currency,
          type: "DEBIT",
          description: feeDescription,
          category: "FX Transfer Fee",
          merchant: `${recipientName} (${recipientAccount}) → ${targetCurrency}`,
        },
        tx
      );
    }
    await chargeOverdraftFeeIfNeeded(tx, fromAccount, debitResult.balanceBefore, debitResult.balanceAfter);
    return debit;
  });

  await flagIfAnomalous(transaction.id, fromAccount.id, amount);

  await writeAuditLog({
    action: "FX_TRANSFER_COMPLETED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Transaction",
    targetId: transaction.id,
    metadata: {
      amount: amount.toString(),
      fromCurrency: fromAccount.currency,
      convertedAmount: convertedAmount.toFixed(2),
      targetCurrency,
      recipientName,
      recipientAccount,
      feeAmount: feeAmount.toString(),
      feeDiscountAmount: discountAmount.toString(),
    },
  });

  return {
    transaction,
    convertedAmount,
    targetCurrency,
    feeAmount,
    feePct: FX_FEE_PCT,
    baseFeeAmount,
    feeDiscountAmount: discountAmount,
    feeDiscountPct: plan.transferDiscountPct,
  };
}

// --- Wire transfer ---------------------------------------------------------------------

// Flat mock fee shown on wire transfers (display only, not deducted — same
// simplification as FX_FEE_PCT above). Wires move same-currency funds out to
// a bank outside LamBank, so there's no conversion involved, just a routing
// number/SWIFT code and (in this demo) a slower "arrives in 1-3 business
// days" framing on the frontend.
export const WIRE_FEE_FLAT = 25;

export interface WireTransferParams {
  fromAccountId: string;
  bankName: string;
  routingNumber: string;
  recipientName: string;
  recipientAccount: string;
  amount: number;
  note?: string;
  merchantCategory?: string;
  otp: string;
}

export async function executeWireTransfer(companyId: string, userId: string, params: WireTransferParams) {
  const { fromAccountId, bankName, routingNumber, recipientName, recipientAccount, amount, note, merchantCategory } = params;

  assertOtp(params.otp);

  const fromAccount = await loadOwnAccount(companyId, fromAccountId);
  const tier = await getCompanyTier(companyId);
  const plan = PLANS[tier];
  const { baseFeeAmount, discountAmount, feeAmount } = applyTransferDiscount(WIRE_FEE_FLAT, plan.transferDiscountPct);

  await authorizeDebit(fromAccount, companyId, amount + feeAmount, amount);

  const description =
    (note?.trim() ? `${note.trim()} — ` : "") +
    `Wire transfer to ${recipientName} (${recipientAccount}) at ${bankName}, routing ${routingNumber}`;
  const feeDescription =
    discountAmount > 0
      ? `Wire transfer fee (${plan.transferDiscountPct}% ${plan.name} plan discount applied)`
      : "Wire transfer fee";
  const transaction = await transfersRepo.runInTransaction(async (tx) => {
    // Principal + fee debited in one guarded statement — see the FX branch above.
    const debitResult = await debitWithinOverdraftLimit(tx, fromAccount.id, amount + feeAmount);
    if (!debitResult.ok) {
      throw new UnprocessableEntityError("Insufficient balance");
    }
    const debit = await transfersRepo.createTransactionRecord(
      {
        accountId: fromAccount.id,
        amount,
        currency: fromAccount.currency,
        type: "DEBIT",
        description,
        category: "Wire Transfer",
        merchant: `${recipientName} (${recipientAccount}) @ ${bankName}`,
        merchantCategory: merchantCategory || undefined,
      },
      tx
    );
    if (feeAmount > 0) {
      await transfersRepo.createTransactionRecord(
        {
          accountId: fromAccount.id,
          amount: feeAmount,
          currency: fromAccount.currency,
          type: "DEBIT",
          description: feeDescription,
          category: "Wire Transfer Fee",
          merchant: `${recipientName} (${recipientAccount}) @ ${bankName}`,
        },
        tx
      );
    }
    await chargeOverdraftFeeIfNeeded(tx, fromAccount, debitResult.balanceBefore, debitResult.balanceAfter);
    return debit;
  });

  await flagIfAnomalous(transaction.id, fromAccount.id, amount);

  await writeAuditLog({
    action: "WIRE_TRANSFER_COMPLETED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Transaction",
    targetId: transaction.id,
    metadata: {
      amount: amount.toString(),
      currency: fromAccount.currency,
      bankName,
      routingNumber,
      recipientName,
      recipientAccount,
      feeAmount: feeAmount.toString(),
      feeDiscountAmount: discountAmount.toString(),
    },
  });

  return {
    transaction,
    feeAmount,
    baseFeeAmount,
    feeDiscountAmount: discountAmount,
    feeDiscountPct: plan.transferDiscountPct,
  };
}
