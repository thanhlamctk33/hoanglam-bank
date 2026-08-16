import { Prisma } from "@prisma/client";
import { OVERDRAFT_FEE } from "./overdraft.config";

/** Whether debiting `amount` from this account is allowed given its overdraft limit. */
export function canDebit(account: { balance: unknown; overdraftLimit: unknown }, amount: number): boolean {
  return Number(account.balance) - amount >= -Number(account.overdraftLimit);
}

/**
 * Call after an account's balance has already been decremented for a debit.
 * If that debit crossed the account from >= 0 into negative, charges a flat
 * OVERDRAFT_FEE as a second DEBIT transaction — same simplification real
 * banks make: the fee is assessed once per time the account goes negative,
 * regardless of what pushed it there. Must run in the same transaction as
 * the debit it's reacting to.
 */
export async function chargeOverdraftFeeIfNeeded(
  tx: Prisma.TransactionClient,
  account: { id: string; currency: string },
  balanceBefore: number,
  balanceAfter: number
): Promise<void> {
  if (balanceBefore >= 0 && balanceAfter < 0) {
    await tx.account.update({ where: { id: account.id }, data: { balance: { decrement: OVERDRAFT_FEE } } });
    await tx.transaction.create({
      data: {
        accountId: account.id,
        amount: OVERDRAFT_FEE,
        currency: account.currency,
        type: "DEBIT",
        description: "Overdraft fee",
        category: "Overdraft fee",
      },
    });
  }
}
