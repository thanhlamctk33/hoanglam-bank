import { MIN_TRANSACTIONS_FOR_ANOMALY_BASELINE, ANOMALY_MULTIPLIER } from "./fraud.config";
import { countRecentDebits, findRecentDebits, findSpendPolicy, flagTransaction } from "./fraud.repository";

/**
 * Velocity check: blocks a debit outright if it would be the
 * (velocityMaxCount + 1)th DEBIT transaction on this account within the
 * trailing velocityWindowMinutes. Company-configurable via SpendPolicy; no
 * policy row (or a null velocityMaxCount) means no limit. Call this BEFORE
 * creating the transaction — unlike the anomaly flag below, this can reject
 * the request.
 */
export async function checkVelocity(companyId: string, accountId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const policy = await findSpendPolicy(companyId);
  if (!policy?.velocityMaxCount) return { ok: true };

  const since = new Date(Date.now() - policy.velocityWindowMinutes * 60 * 1000);
  const count = await countRecentDebits(accountId, since);

  if (count >= policy.velocityMaxCount) {
    return {
      ok: false,
      error: `Too many transactions on this account in the last ${policy.velocityWindowMinutes} minutes (limit ${policy.velocityMaxCount}). Try again shortly.`,
    };
  }
  return { ok: true };
}

/**
 * Anomaly flag: compares a just-created debit against the average of the
 * account's last ANOMALY_LOOKBACK_COUNT debits (excluding this one). If
 * it's more than ANOMALY_MULTIPLIER times that average, flags the
 * transaction for review — informational only, never blocks or reverses
 * anything. Call this AFTER creating the transaction.
 */
export async function flagIfAnomalous(transactionId: string, accountId: string, amount: number): Promise<void> {
  const recent = await findRecentDebits(accountId, transactionId);

  if (recent.length < MIN_TRANSACTIONS_FOR_ANOMALY_BASELINE) return;

  const avg = recent.reduce((sum, transaction) => sum + Number(transaction.amount), 0) / recent.length;
  if (avg <= 0 || amount <= avg * ANOMALY_MULTIPLIER) return;

  await flagTransaction(transactionId, `${(amount / avg).toFixed(1)}x this account's recent average debit (${avg.toFixed(2)})`);
}
