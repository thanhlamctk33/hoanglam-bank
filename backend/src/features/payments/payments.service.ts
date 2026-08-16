import { Account } from "@prisma/client";
import {
  BadRequestError,
  ForbiddenError,
  LockedError,
  NotFoundError,
  TooManyRequestsError,
  UnprocessableEntityError,
} from "../../errors/AppError";
import { PLANS } from "../subscription/plans.config";
import { getCompanyTier } from "../subscription/subscription.service";
import { checkTransactionAllowed } from "../kyb/kyb.service";
import { assertOtp } from "../../shared/otp/otp.service";
import { canDebit, chargeOverdraftFeeIfNeeded } from "../../shared/overdraft/overdraft.service";
import { checkVelocity, flagIfAnomalous } from "../../shared/fraud/fraud.service";
import { UTILITY_PROVIDERS } from "./payments.config";
import * as paymentsRepo from "./payments.repository";

/**
 * Business logic for utility bill payments and QR Pay — every route in
 * payments.routes.ts is a thin validate-then-call-this wrapper. All Prisma
 * access goes through payments.repository.ts.
 */

/** Loads a company's own account, or throws if it doesn't exist or is frozen. */
async function loadOwnAccount(companyId: string, accountId: string, missingMessage: string) {
  const account = await paymentsRepo.findOwnAccount(companyId, accountId);
  if (!account) {
    throw new NotFoundError(missingMessage);
  }
  if (account.frozen) {
    throw new LockedError("This account is frozen");
  }
  return account;
}

/**
 * The checks that gate money leaving `account`: available balance, velocity
 * limit, and the company's KYB transaction limit. `debitAmount` is what must
 * be available; `kybAmount` is what counts against the KYB cap (the
 * pre-discount amount for utility payments, matching prior behavior).
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

// --- Utility bill payments -----------------------------------------------------------

export interface PayUtilityParams {
  accountId: string;
  providerId: string;
  customerCode: string;
  amount: number;
}

export async function payUtility(companyId: string, params: PayUtilityParams) {
  const { accountId, providerId, customerCode, amount } = params;
  const provider = UTILITY_PROVIDERS.find((p) => p.id === providerId)!;

  const account = await loadOwnAccount(companyId, accountId, "Account not found");

  const tier = await getCompanyTier(companyId);
  const plan = PLANS[tier];
  const discountAmount = Math.round(amount * (plan.spendDiscountPct / 100) * 100) / 100;
  const amountCharged = Math.round((amount - discountAmount) * 100) / 100;

  // The discount reduces what's debited, but the KYB cap still applies to the
  // full pre-discount amount — a plan perk shouldn't widen a compliance limit.
  await authorizeDebit(account, companyId, amountCharged, amount);

  const description =
    discountAmount > 0
      ? `Payment for ${provider.name} - ${customerCode} (${plan.spendDiscountPct}% ${plan.name} plan discount applied)`
      : `Payment for ${provider.name} - ${customerCode}`;
  const utilityBalanceBefore = Number(account.balance);

  const transaction = await paymentsRepo.runInTransaction(async (tx) => {
    await paymentsRepo.decrementBalance(account.id, amountCharged, tx);
    await chargeOverdraftFeeIfNeeded(tx, account, utilityBalanceBefore, utilityBalanceBefore - amountCharged);
    return paymentsRepo.createTransactionRecord(
      {
        accountId: account.id,
        amount: amountCharged,
        currency: account.currency,
        type: "DEBIT",
        description,
        category: provider.category,
        merchant: provider.name,
      },
      tx
    );
  });

  await flagIfAnomalous(transaction.id, account.id, amountCharged);

  return { transaction, originalAmount: amount, discountAmount, amountCharged };
}

// --- QR Pay ---------------------------------------------------------------------------

export interface MyQrCodeParams {
  accountId?: string;
  amount?: number;
  note?: string;
}

export async function getMyQrCode(companyId: string, params: MyQrCodeParams) {
  const account = params.accountId
    ? await paymentsRepo.findOwnAccount(companyId, params.accountId)
    : await paymentsRepo.findFirstAccount(companyId);
  if (!account) {
    throw new NotFoundError("No account found");
  }

  const amount = params.amount && params.amount > 0 ? params.amount : undefined;
  const note = params.note?.trim() ?? "";

  // Payload format: HLBQR:<accountNumber> for a plain "pay me" code, or
  // HLBQR:<accountNumber>|<amount>|<note> when the merchant is requesting a
  // specific amount — the note is URL-encoded since it can contain "|".
  const payload = amount
    ? `HLBQR:${account.accountNumber}|${amount}|${encodeURIComponent(note)}`
    : `HLBQR:${account.accountNumber}`;

  return {
    accountId: account.id,
    accountNumber: account.accountNumber,
    accountName: account.name,
    currency: account.currency,
    requestedAmount: amount ?? null,
    note: note || null,
    payload,
  };
}

export interface QrPayParams {
  fromAccountId: string;
  payload: string;
  amount: number;
  note?: string;
  otp: string;
}

export async function payByQr(companyId: string, params: QrPayParams) {
  const { fromAccountId, payload, amount, note, otp } = params;

  assertOtp(otp);

  const match = /^HLBQR:(.+)$/.exec(payload.trim());
  if (!match) {
    throw new BadRequestError("Invalid QR code");
  }
  const toAccountNumber = match[1];

  const fromAccount = await loadOwnAccount(companyId, fromAccountId, "Source account not found");

  const toAccount = await paymentsRepo.findAccountByNumber(toAccountNumber);
  if (!toAccount) {
    throw new NotFoundError("QR merchant account not found");
  }
  if (toAccount.id === fromAccount.id) {
    throw new BadRequestError("Cannot pay yourself");
  }

  await authorizeDebit(fromAccount, companyId, amount);

  const qrBalanceBefore = Number(fromAccount.balance);

  const transaction = await paymentsRepo.runInTransaction(async (tx) => {
    await paymentsRepo.decrementBalance(fromAccount.id, amount, tx);
    await paymentsRepo.incrementBalance(toAccount.id, amount, tx);
    await chargeOverdraftFeeIfNeeded(tx, fromAccount, qrBalanceBefore, qrBalanceBefore - amount);

    const debit = await paymentsRepo.createTransactionRecord(
      {
        accountId: fromAccount.id,
        amount,
        currency: fromAccount.currency,
        type: "DEBIT",
        description: note?.trim() || `QR Pay to ${toAccount.accountNumber}`,
        category: "QR Pay",
        merchant: toAccount.accountNumber,
      },
      tx
    );
    await paymentsRepo.createTransactionRecord(
      {
        accountId: toAccount.id,
        amount,
        currency: toAccount.currency,
        type: "CREDIT",
        description: note?.trim() || `QR Pay from ${fromAccount.accountNumber}`,
        category: "QR Pay",
        merchant: fromAccount.accountNumber,
      },
      tx
    );

    return debit;
  });

  await flagIfAnomalous(transaction.id, fromAccount.id, amount);

  return transaction;
}
