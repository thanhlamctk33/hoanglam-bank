/**
 * Fraud/velocity defaults. The velocity limit itself (max transactions per
 * window) is per-company via SpendPolicy.velocityMaxCount — these are just
 * the fixed parts of the anomaly heuristic, which isn't company-configurable.
 */

/** How many of an account's most recent DEBIT transactions form the "recent average" baseline. */
export const ANOMALY_LOOKBACK_COUNT = 10;

/** Need at least this many prior transactions before an anomaly comparison is meaningful. */
export const MIN_TRANSACTIONS_FOR_ANOMALY_BASELINE = 3;

/** A debit this many times the recent average gets flagged (not blocked). */
export const ANOMALY_MULTIPLIER = 5;
