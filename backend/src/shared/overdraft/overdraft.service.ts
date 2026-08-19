import { Prisma } from "@prisma/client";
import { OVERDRAFT_FEE } from "./overdraft.config";

/**
 * Whether debiting `amount` from this account is allowed given its overdraft
 * limit — evaluated against an account row that was read *earlier*.
 *
 * Use this for the early "can we even start this?" check that produces a nice
 * error message, but never as the only guard before actually moving money:
 * between the read and the write another request can debit the same account,
 * so two transfers can both pass this check and together overdraw the
 * account. `debitWithinOverdraftLimit` below closes that gap.
 */
export function canDebit(account: { balance: unknown; overdraftLimit: unknown }, amount: number): boolean {
  return Number(account.balance) - amount >= -Number(account.overdraftLimit);
}

/**
 * Debits `amount` and re-checks the overdraft limit **in the same statement**,
 * so a concurrent debit can't slip in between the check and the write. The
 * database evaluates `balance - amount >= -overdraftLimit` against the row as
 * it exists at that instant, and the UPDATE simply matches no row when the
 * money is no longer there.
 *
 * Returns `{ ok: false }` when the account no longer has room — callers should
 * treat that as "insufficient balance" and abort the surrounding transaction.
 * On success it also reports the balance either side of the debit, which is
 * what `chargeOverdraftFeeIfNeeded` needs; taking those from the UPDATE itself
 * rather than from the earlier read keeps the fee decision correct even when
 * another debit landed in between.
 *
 * Written as raw SQL because Prisma's `where` can't compare one column
 * against another (`balance` against `overdraftLimit`).
 */
export type DebitResult = { ok: false } | { ok: true; balanceBefore: number; balanceAfter: number };

export async function debitWithinOverdraftLimit(
  db: Prisma.TransactionClient,
  accountId: string,
  amount: number
): Promise<DebitResult> {
  const updatedRows = await db.$queryRaw<{ balance: Prisma.Decimal }[]>`
    UPDATE "Account"
       SET balance = balance - ${amount}::numeric
     WHERE id = ${accountId}
       AND balance - ${amount}::numeric >= -"overdraftLimit"
    RETURNING balance
  `;
  if (updatedRows.length === 0) {
    return { ok: false };
  }
  const balanceAfter = Number(updatedRows[0].balance);
  return { ok: true, balanceBefore: balanceAfter + amount, balanceAfter };
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
