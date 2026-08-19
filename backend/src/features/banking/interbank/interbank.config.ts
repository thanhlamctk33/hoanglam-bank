/**
 * Defaults for Interbank Lending — LamBank's own treasury/money-market desk
 * lending to other banks, distinct from Credit (LamBank lending to its
 * customer companies).
 */

/** Starting capital in the singleton TreasuryBook, lazily created on first use. */
export const TREASURY_INITIAL_BALANCE = 50_000_000;

/** Smallest principal for a single interbank loan. */
export const MIN_INTERBANK_LOAN_AMOUNT = 100_000;

/** Standard money-market tenors offered when booking a loan. */
export const INTERBANK_TERM_OPTIONS: { label: string; days: number }[] = [
  { label: "Overnight", days: 1 },
  { label: "1 Week", days: 7 },
  { label: "1 Month", days: 30 },
  { label: "3 Months", days: 90 },
  { label: "6 Months", days: 180 },
  { label: "1 Year", days: 365 },
];

/** Day-count convention for interest: simple interest, actual days / 365. */
export const INTERBANK_DAY_COUNT_BASIS = 365;
