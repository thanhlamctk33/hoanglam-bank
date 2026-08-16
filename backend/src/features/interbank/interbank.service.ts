import { INTERBANK_DAY_COUNT_BASIS } from "./interbank.config";
import { findTreasuryBook, createTreasuryBook, findActiveLoansByCounterparty } from "./interbank.repository";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The TreasuryBook is a singleton row representing LamBank's own lending
 * capital — separate from every customer Account. Lazily created with its
 * starting balance on first use, same pattern as getOrCreatePrimaryAccount
 * for a company's cash account.
 */
export async function getOrCreateTreasuryBook() {
  const existing = await findTreasuryBook();
  if (existing) return existing;
  return createTreasuryBook();
}

/**
 * Simple interest (ACT/365): principal * rate% * days/365. Used both to
 * quote a loan up front (over its full termDays) and to settle it (over the
 * actual days held, capped at termDays — see below).
 */
export function computeInterest(principal: number, interestRatePct: number, days: number): number {
  return round2(principal * (interestRatePct / 100) * (days / INTERBANK_DAY_COUNT_BASIS));
}

/**
 * Days actually held, for prorating interest at settlement: capped at the
 * agreed termDays so settling late doesn't keep accruing beyond what was
 * quoted, and at least 1 day so an instant same-day settlement still earns
 * something.
 */
export function daysHeld(startDate: Date, now: Date, termDays: number): number {
  const elapsed = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  return Math.min(termDays, Math.max(1, elapsed));
}

/** Sum of principal across a counterparty's currently-ACTIVE loans. */
export async function getCounterpartyExposure(counterpartyId: string): Promise<number> {
  const active = await findActiveLoansByCounterparty(counterpartyId);
  return round2(active.reduce((sum: number, l: (typeof active)[number]) => sum + Number(l.principal), 0));
}
