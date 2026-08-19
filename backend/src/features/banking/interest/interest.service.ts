import { DEPOSIT_INTEREST_RATE_PCT, MIN_INTEREST_ACCRUAL_AMOUNT } from "./deposits.config";
import { findInterestEligibleAccounts, touchLastInterestAccrualAt, postInterestAccrual } from "./interest.repository";

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Lazily accrues deposit interest on every Savings/Money Market account in
 * a company — no background worker exists in this app, so (same as
 * Recurring Transfers and auto-deduct installments) this just catches up
 * whenever the account list is loaded. Simple interest (ACT/365) since
 * lastInterestAccrualAt is posted as its own CREDIT Transaction, so it
 * shows up naturally in the account's history rather than silently
 * appearing in the balance.
 */
export async function accrueInterest(companyId: string): Promise<void> {
  const accounts = await findInterestEligibleAccounts(companyId);

  const now = new Date();
  for (const account of accounts) {
    const rate = DEPOSIT_INTEREST_RATE_PCT[account.type];
    const balance = Number(account.balance);

    if (rate <= 0 || balance <= 0) {
      // Nothing to accrue — but still roll the clock forward so a later
      // deposit doesn't retroactively earn interest for a zero-balance
      // stretch.
      if (new Date(account.lastInterestAccrualAt).getTime() !== now.getTime()) {
        await touchLastInterestAccrualAt(account.id, now);
      }
      continue;
    }

    const days = Math.floor((now.getTime() - new Date(account.lastInterestAccrualAt).getTime()) / (1000 * 60 * 60 * 24));
    if (days <= 0) continue;

    const interest = roundToCents(balance * (rate / 100) * (days / 365));
    if (interest < MIN_INTEREST_ACCRUAL_AMOUNT) continue;

    await postInterestAccrual(
      account.id,
      account.currency,
      interest,
      now,
      `Interest earned (${rate}% APY, ${days} day${days === 1 ? "" : "s"})`
    );
  }
}
