import { describe, expect, it, vi } from "vitest";

vi.mock("./repayment.repository", () => ({}));
vi.mock("../../shared/audit/audit.service", () => ({ writeAuditLog: vi.fn(), resolveActorEmail: vi.fn() }));

import { generateInstallmentSchedule } from "./repayment.service";
import { BALLOON_PRINCIPAL_PCT } from "../credit/lending.config";

const startDate = new Date("2026-01-15T00:00:00Z");

const baseLoanParams = {
  amount: 12_000,
  interestRatePct: 12,
  termMonths: 12,
  graceMonths: 0,
  startDate,
};

const sumPrincipal = (installments: { principalDue: number }[]) =>
  Math.round(installments.reduce((sum, installment) => sum + installment.principalDue, 0) * 100) / 100;

describe("generateInstallmentSchedule — REVOLVING", () => {
  it("produces no schedule, since revolving credit has no fixed installments", () => {
    expect(generateInstallmentSchedule({ ...baseLoanParams, method: "REVOLVING" })).toEqual([]);
  });
});

describe("generateInstallmentSchedule — AMORTIZING", () => {
  const schedule = generateInstallmentSchedule({ ...baseLoanParams, method: "AMORTIZING" });

  it("emits one row per month of the term", () => {
    expect(schedule).toHaveLength(12);
    expect(schedule.map((installment) => installment.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("repays exactly the principal drawn, no more and no less", () => {
    // The single most important invariant: a rounding drift here would leave
    // the borrower permanently owing (or owed) a few cents.
    expect(sumPrincipal(schedule)).toBe(12_000);
  });

  it("charges decreasing interest as the balance amortizes", () => {
    for (let index = 1; index < schedule.length; index++) {
      expect(schedule[index].interestDue).toBeLessThanOrEqual(schedule[index - 1].interestDue);
    }
    expect(schedule[schedule.length - 1].interestDue).toBeLessThan(schedule[0].interestDue);
  });

  it("charges first-month interest on the full balance", () => {
    // 12,000 at 12% APR = 1% monthly = 120.
    expect(schedule[0].interestDue).toBeCloseTo(120, 2);
  });

  it("keeps every payment non-negative", () => {
    for (const installment of schedule) {
      expect(installment.principalDue).toBeGreaterThanOrEqual(0);
      expect(installment.interestDue).toBeGreaterThanOrEqual(0);
    }
  });

  it("schedules due dates one month apart, starting a month after drawdown", () => {
    expect(schedule[0].dueDate.getUTCMonth()).toBe(1); // February
    expect(schedule[11].dueDate.getUTCFullYear()).toBe(2027);
  });

  it("splits principal evenly when the rate is zero", () => {
    const zeroRateSchedule = generateInstallmentSchedule({ ...baseLoanParams, interestRatePct: 0, method: "AMORTIZING" });
    expect(sumPrincipal(zeroRateSchedule)).toBe(12_000);
    for (const installment of zeroRateSchedule) {
      expect(installment.interestDue).toBe(0);
      expect(installment.principalDue).toBeCloseTo(1_000, 2);
    }
  });

  it("shortens the paying period by the grace months but still repays in full", () => {
    const scheduleWithGrace = generateInstallmentSchedule({ ...baseLoanParams, graceMonths: 3, method: "AMORTIZING" });
    expect(scheduleWithGrace).toHaveLength(9);
    expect(sumPrincipal(scheduleWithGrace)).toBe(12_000);
    // First payment lands after the 3-month grace period (Jan + 3 + 1 = May).
    expect(scheduleWithGrace[0].dueDate.getUTCMonth()).toBe(4);
  });
});

describe("generateInstallmentSchedule — INTEREST_ONLY", () => {
  const schedule = generateInstallmentSchedule({ ...baseLoanParams, method: "INTEREST_ONLY" });

  it("defers all principal to the final payment", () => {
    for (const installment of schedule.slice(0, -1)) {
      expect(installment.principalDue).toBe(0);
    }
    expect(schedule[schedule.length - 1].principalDue).toBe(12_000);
  });

  it("repays exactly the principal drawn", () => {
    expect(sumPrincipal(schedule)).toBe(12_000);
  });

  it("charges the same interest every period, since the balance never drops", () => {
    const distinctInterestAmounts = new Set(schedule.map((installment) => installment.interestDue));
    expect(distinctInterestAmounts.size).toBe(1);
    expect(schedule[0].interestDue).toBeCloseTo(120, 2);
  });

  it("costs more total interest than an amortizing schedule of the same size", () => {
    const amortizingSchedule = generateInstallmentSchedule({ ...baseLoanParams, method: "AMORTIZING" });
    const totalInterestOnlyInterest = schedule.reduce((sum, installment) => sum + installment.interestDue, 0);
    const totalAmortizingInterest = amortizingSchedule.reduce((sum, installment) => sum + installment.interestDue, 0);
    expect(totalInterestOnlyInterest).toBeGreaterThan(totalAmortizingInterest);
  });
});

describe("generateInstallmentSchedule — BALLOON", () => {
  const schedule = generateInstallmentSchedule({ ...baseLoanParams, method: "BALLOON" });

  it("repays exactly the principal drawn", () => {
    expect(sumPrincipal(schedule)).toBe(12_000);
  });

  it("defers a large final payment covering at least the balloon share", () => {
    const balloonShare = 12_000 * (BALLOON_PRINCIPAL_PCT / 100);
    const finalPrincipal = schedule[schedule.length - 1].principalDue;
    expect(finalPrincipal).toBeGreaterThanOrEqual(balloonShare);
  });

  it("makes the final principal payment far larger than the earlier ones", () => {
    const finalPrincipalDue = schedule[schedule.length - 1].principalDue;
    for (const installment of schedule.slice(0, -1)) {
      expect(finalPrincipalDue).toBeGreaterThan(installment.principalDue);
    }
  });

  it("keeps every payment non-negative", () => {
    for (const installment of schedule) {
      expect(installment.principalDue).toBeGreaterThanOrEqual(0);
      expect(installment.interestDue).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("generateInstallmentSchedule — edge cases", () => {
  it("still emits one payment when grace consumes the whole term", () => {
    const schedule = generateInstallmentSchedule({
      ...baseLoanParams,
      graceMonths: 12,
      method: "AMORTIZING",
    });
    expect(schedule).toHaveLength(1);
    expect(sumPrincipal(schedule)).toBe(12_000);
  });

  it("repays odd amounts exactly, without leaving a rounding remainder", () => {
    for (const amount of [1_000, 3_333.33, 99_999.99, 250_000]) {
      for (const method of ["AMORTIZING", "INTEREST_ONLY", "BALLOON"] as const) {
        const schedule = generateInstallmentSchedule({ ...baseLoanParams, amount, method });
        expect(sumPrincipal(schedule), `${method} @ ${amount}`).toBeCloseTo(amount, 2);
      }
    }
  });

  it("handles a single-month term", () => {
    const schedule = generateInstallmentSchedule({ ...baseLoanParams, termMonths: 1, method: "AMORTIZING" });
    expect(schedule).toHaveLength(1);
    expect(schedule[0].principalDue).toBe(12_000);
  });
});
