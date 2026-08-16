import { AccountType } from "@prisma/client";

/**
 * Annual deposit interest rate (%) by account type, accrued daily (simple
 * interest, ACT/365) and posted lazily — see utils/interest.ts. CHECKING
 * pays nothing, matching how most business checking accounts work.
 */
export const DEPOSIT_INTEREST_RATE_PCT: Record<AccountType, number> = {
  CHECKING: 0,
  SAVINGS: 2,
  MONEY_MARKET: 3.5,
};

/** Smallest interest amount worth posting as its own Transaction. */
export const MIN_INTEREST_ACCRUAL_AMOUNT = 0.01;
