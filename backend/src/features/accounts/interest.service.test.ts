import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./interest.repository", () => ({
  findInterestEligibleAccounts: vi.fn(),
  touchLastInterestAccrualAt: vi.fn(),
  postInterestAccrual: vi.fn(),
}));

import { accrueInterest } from "./interest.service";
import * as interestRepo from "./interest.repository";
import { DEPOSIT_INTEREST_RATE_PCT, MIN_INTEREST_ACCRUAL_AMOUNT } from "./deposits.config";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const savingsAccount = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "acc-1",
  type: "SAVINGS" as const,
  currency: "USD",
  balance: 100_000,
  lastInterestAccrualAt: daysAgo(365),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("accrueInterest", () => {
  it("posts a year of simple interest at the account type's rate", async () => {
    vi.mocked(interestRepo.findInterestEligibleAccounts).mockResolvedValue([savingsAccount()] as never);

    await accrueInterest("company-1");

    expect(interestRepo.postInterestAccrual).toHaveBeenCalledTimes(1);
    const [accountId, currency, interest, , description] = vi.mocked(interestRepo.postInterestAccrual).mock.calls[0];
    expect(accountId).toBe("acc-1");
    expect(currency).toBe("USD");
    // 100,000 at 2% APY for 365 days = 2,000.
    expect(interest).toBeCloseTo(100_000 * (DEPOSIT_INTEREST_RATE_PCT.SAVINGS / 100), 2);
    expect(description).toContain(`${DEPOSIT_INTEREST_RATE_PCT.SAVINGS}% APY`);
  });

  it("pays the higher money-market rate on a MONEY_MARKET account", async () => {
    vi.mocked(interestRepo.findInterestEligibleAccounts).mockResolvedValue([
      savingsAccount({ type: "MONEY_MARKET" }),
    ] as never);

    await accrueInterest("company-1");

    const interest = vi.mocked(interestRepo.postInterestAccrual).mock.calls[0][2];
    expect(interest).toBeCloseTo(100_000 * (DEPOSIT_INTEREST_RATE_PCT.MONEY_MARKET / 100), 2);
    expect(DEPOSIT_INTEREST_RATE_PCT.MONEY_MARKET).toBeGreaterThan(DEPOSIT_INTEREST_RATE_PCT.SAVINGS);
  });

  it("prorates by elapsed days rather than always paying a full year", async () => {
    vi.mocked(interestRepo.findInterestEligibleAccounts).mockResolvedValue([
      savingsAccount({ lastInterestAccrualAt: daysAgo(30) }),
    ] as never);

    await accrueInterest("company-1");

    const interest = vi.mocked(interestRepo.postInterestAccrual).mock.calls[0][2];
    expect(interest).toBeCloseTo(100_000 * 0.02 * (30 / 365), 2);
  });

  it("accrues nothing when no full day has passed", async () => {
    vi.mocked(interestRepo.findInterestEligibleAccounts).mockResolvedValue([
      savingsAccount({ lastInterestAccrualAt: new Date() }),
    ] as never);

    await accrueInterest("company-1");

    expect(interestRepo.postInterestAccrual).not.toHaveBeenCalled();
  });

  it("skips posting when the accrual rounds below the minimum worth recording", async () => {
    // A tiny balance for one day earns fractions of a cent — not worth its
    // own Transaction row.
    vi.mocked(interestRepo.findInterestEligibleAccounts).mockResolvedValue([
      savingsAccount({ balance: 1, lastInterestAccrualAt: daysAgo(1) }),
    ] as never);

    await accrueInterest("company-1");

    expect(interestRepo.postInterestAccrual).not.toHaveBeenCalled();
    expect(MIN_INTEREST_ACCRUAL_AMOUNT).toBeGreaterThan(0);
  });

  it("rolls the clock forward on a zero-balance account instead of posting", async () => {
    // Without this, a later deposit would retroactively earn interest for the
    // whole empty stretch.
    vi.mocked(interestRepo.findInterestEligibleAccounts).mockResolvedValue([
      savingsAccount({ balance: 0 }),
    ] as never);

    await accrueInterest("company-1");

    expect(interestRepo.postInterestAccrual).not.toHaveBeenCalled();
    expect(interestRepo.touchLastInterestAccrualAt).toHaveBeenCalledWith("acc-1", expect.any(Date));
  });

  it("never pays interest on a negative balance", async () => {
    vi.mocked(interestRepo.findInterestEligibleAccounts).mockResolvedValue([
      savingsAccount({ balance: -5_000 }),
    ] as never);

    await accrueInterest("company-1");

    expect(interestRepo.postInterestAccrual).not.toHaveBeenCalled();
  });

  it("processes every eligible account in the company", async () => {
    vi.mocked(interestRepo.findInterestEligibleAccounts).mockResolvedValue([
      savingsAccount({ id: "acc-1" }),
      savingsAccount({ id: "acc-2", type: "MONEY_MARKET" }),
    ] as never);

    await accrueInterest("company-1");

    expect(interestRepo.postInterestAccrual).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the company has no savings accounts", async () => {
    vi.mocked(interestRepo.findInterestEligibleAccounts).mockResolvedValue([] as never);

    await accrueInterest("company-1");

    expect(interestRepo.postInterestAccrual).not.toHaveBeenCalled();
    expect(interestRepo.touchLastInterestAccrualAt).not.toHaveBeenCalled();
  });
});

describe("deposit rate table", () => {
  it("pays nothing on checking, matching normal business banking", () => {
    expect(DEPOSIT_INTEREST_RATE_PCT.CHECKING).toBe(0);
  });
});
