/**
 * Defaults for the lending flow (Credit Apply -> Drawdown -> Repayment).
 * No per-company pricing config exists yet, so these are fixed defaults
 * applied to every drawdown, mirroring how POLICY_LIMIT works for claims.
 */

/** Annual interest rate (%) snapshotted onto every Drawdown. */
export const DEFAULT_INTEREST_RATE_PCT = 12;

/** Loan tenor in months snapshotted onto every Drawdown. */
export const DEFAULT_TERM_MONTHS = 12;

/** Smallest amount a company may request in a single Credit Apply. */
export const MIN_CREDIT_APPLY_AMOUNT = 1000;

/** Smallest amount a company may draw down in one go. */
export const MIN_DRAWDOWN_AMOUNT = 100;

/**
 * One-time drawdown fee (% of the amount drawn), charged as a separate
 * DEBIT transaction and netted out of the cash actually received — it does
 * not add to the principal owed. Mirrors a real facility's drawdown/
 * utilization fee.
 */
export const DRAWDOWN_FEE_PCT = 0.5;

/**
 * Late fee charged once, the first time an installment is found overdue —
 * a flat percentage of that installment's remaining amount due. Added to
 * the installment's own feeDue so it's collected via the same waterfall as
 * everything else (fee first, then interest, then principal).
 */
export const LATE_FEE_PCT = 2;

/**
 * Fraction of principal deferred to the final installment on a BALLOON
 * schedule. The rest amortizes normally (interest + partial principal)
 * over the term.
 */
export const BALLOON_PRINCIPAL_PCT = 50;

/** Longest grace period a drawdown's schedule can start with. */
export const MAX_GRACE_MONTHS = 6;
