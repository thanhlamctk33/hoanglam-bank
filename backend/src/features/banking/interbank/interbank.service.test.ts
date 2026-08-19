import { describe, expect, it, vi, beforeEach } from "vitest";

// Every repository call reaches Prisma, so the whole module is mocked — this
// keeps the suite a true unit test: no database, no generated client needed.
vi.mock("./interbank.repository", () => ({
  findActiveLoansByCounterparty: vi.fn(),
  findTreasuryBook: vi.fn(),
  createTreasuryBook: vi.fn(),
  runInTransaction: vi.fn(),
  adjustTreasuryBalance: vi.fn(),
  findTreasuryTransactions: vi.fn(),
  createTreasuryTransaction: vi.fn(),
  countCounterparties: vi.fn(),
  findCounterparties: vi.fn(),
  findCounterpartiesByIds: vi.fn(),
  findCounterpartyById: vi.fn(),
  findCounterpartyBySwift: vi.fn(),
  createCounterparty: vi.fn(),
  findActiveLoanPrincipals: vi.fn(),
  findLoans: vi.fn(),
  findLoanById: vi.fn(),
  createLoan: vi.fn(),
  settleLoan: vi.fn(),
  defaultLoan: vi.fn(),
}));
vi.mock("../../shared/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
  resolveActorEmail: vi.fn().mockResolvedValue("test@example.com"),
}));

import { computeInterest, daysHeld, getCounterpartyExposure, getOrCreateTreasuryBook } from "./interbank.service";
import * as interbankRepo from "./interbank.repository";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeInterest", () => {
  it("computes simple ACT/365 interest over a full year", () => {
    // 1,000,000 at 5% for 365 days = 50,000 exactly.
    expect(computeInterest(1_000_000, 5, 365)).toBe(50_000);
  });

  it("prorates by actual days held", () => {
    // 1,000,000 at 5% for 30 days = 1,000,000 * 0.05 * 30/365.
    expect(computeInterest(1_000_000, 5, 30)).toBeCloseTo(4109.59, 2);
  });

  it("rounds to two decimal places", () => {
    const interest = computeInterest(123_456, 4.37, 17);
    expect(interest).toBe(Math.round(interest * 100) / 100);
  });

  it("returns zero for a zero rate or zero principal", () => {
    expect(computeInterest(1_000_000, 0, 365)).toBe(0);
    expect(computeInterest(0, 5, 365)).toBe(0);
  });

  it("returns zero when no days have elapsed", () => {
    expect(computeInterest(1_000_000, 5, 0)).toBe(0);
  });

  it("scales linearly with principal", () => {
    const interestOnBasePrincipal = computeInterest(100_000, 6, 90);
    const interestOnDoublePrincipal = computeInterest(200_000, 6, 90);
    expect(interestOnDoublePrincipal).toBeCloseTo(interestOnBasePrincipal * 2, 2);
  });
});

describe("daysHeld", () => {
  const loanStartDate = new Date("2026-01-01T00:00:00Z");
  const daysAfterStart = (days: number) => new Date(loanStartDate.getTime() + days * 24 * 60 * 60 * 1000);

  it("counts whole elapsed days", () => {
    expect(daysHeld(loanStartDate, daysAfterStart(10), 30)).toBe(10);
  });

  it("floors a partial day", () => {
    expect(daysHeld(loanStartDate, new Date(loanStartDate.getTime() + 10.9 * 24 * 60 * 60 * 1000), 30)).toBe(10);
  });

  it("bills at least one day for a same-day settlement", () => {
    // An instant settle still earns a day of interest rather than nothing.
    expect(daysHeld(loanStartDate, loanStartDate, 30)).toBe(1);
    expect(daysHeld(loanStartDate, new Date(loanStartDate.getTime() + 60_000), 30)).toBe(1);
  });

  it("caps at the agreed term so settling late doesn't over-accrue", () => {
    expect(daysHeld(loanStartDate, daysAfterStart(45), 30)).toBe(30);
    expect(daysHeld(loanStartDate, daysAfterStart(365), 30)).toBe(30);
  });

  it("returns exactly the term when settled on the maturity date", () => {
    expect(daysHeld(loanStartDate, daysAfterStart(30), 30)).toBe(30);
  });
});

describe("getCounterpartyExposure", () => {
  it("sums principal across a counterparty's active loans", async () => {
    vi.mocked(interbankRepo.findActiveLoansByCounterparty).mockResolvedValue([
      { principal: 500_000 },
      { principal: 250_000 },
    ] as never);

    await expect(getCounterpartyExposure("cp-1")).resolves.toBe(750_000);
  });

  it("returns zero when the counterparty has no active loans", async () => {
    vi.mocked(interbankRepo.findActiveLoansByCounterparty).mockResolvedValue([] as never);
    await expect(getCounterpartyExposure("cp-1")).resolves.toBe(0);
  });

  it("coerces Prisma Decimal-like principals instead of concatenating them", async () => {
    // If these were treated as strings the result would be "500000250000".
    vi.mocked(interbankRepo.findActiveLoansByCounterparty).mockResolvedValue([
      { principal: "500000" },
      { principal: "250000" },
    ] as never);

    await expect(getCounterpartyExposure("cp-1")).resolves.toBe(750_000);
  });
});

describe("getOrCreateTreasuryBook", () => {
  it("returns the existing singleton book when one exists", async () => {
    const treasuryBook = { id: "book-1", balance: 1_000 };
    vi.mocked(interbankRepo.findTreasuryBook).mockResolvedValue(treasuryBook as never);

    await expect(getOrCreateTreasuryBook()).resolves.toBe(treasuryBook);
    expect(interbankRepo.createTreasuryBook).not.toHaveBeenCalled();
  });

  it("lazily creates the book on first use", async () => {
    const createdBook = { id: "book-new", balance: 50_000_000 };
    vi.mocked(interbankRepo.findTreasuryBook).mockResolvedValue(null as never);
    vi.mocked(interbankRepo.createTreasuryBook).mockResolvedValue(createdBook as never);

    await expect(getOrCreateTreasuryBook()).resolves.toBe(createdBook);
    expect(interbankRepo.createTreasuryBook).toHaveBeenCalledTimes(1);
  });
});
