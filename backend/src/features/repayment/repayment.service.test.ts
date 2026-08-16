import { describe, expect, it, vi } from "vitest";

vi.mock("./repayment.repository", () => ({}));
vi.mock("../../shared/audit/audit.service", () => ({ writeAuditLog: vi.fn(), resolveActorEmail: vi.fn() }));

import { generateInstallmentSchedule } from "./repayment.service";
import { BALLOON_PRINCIPAL_PCT } from "../credit/lending.config";

const startDate = new Date("2026-01-15T00:00:00Z");

const baseParams = {
  amount: 12_000,
  interestRatePct: 12,
  termMonths: 12,
  graceMonths: 0,
  startDate,
};

const sumPrincipal = (rows: { principalDue: number }[]) =>
  Math.round(rows.reduce((s, r) => s + r.principalDue, 0) * 100) / 100;

describe("generateInstallmentSchedule — REVOLVING", () => {
  it("produces no schedule, since revolving credit has no fixed installments", () => {
    expect(generateInstallmentSchedule({ ...baseParams, method: "REVOLVING" })).toEqual([]);
  });
});

describe("generateInstallmentSchedule — AMORTIZING", () => {
  const schedule = generateInstallmentSchedule({ ...baseParams, method: "AMORTIZING" });

  it("emits one row per month of the term", () => {
    expect(schedule).toHaveLength(12);
    expect(schedule.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("repays exactly the principal drawn, no more and no less", () => {
    // The single most important invariant: a rounding drift here would leave
    // the borrower permanently owing (or owed) a few cents.
    expect(sumPrincipal(schedule)).toBe(12_000);
  });

  it("charges decreasing interest as the balance amortizes", () => {
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i].interestDue).toBeLessThanOrEqual(schedule[i - 1].interestDue);
    }
    expect(schedule[schedule.length - 1].interestDue).toBeLessThan(schedule[0].interestDue);
  });

  it("charges first-month interest on the full balance", () => {
    // 12,000 at 12% APR = 1% monthly = 120.
    expect(schedule[0].interestDue).toBeCloseTo(120, 2);
  });

  it("keeps every payment non-negative", () => {
    for (const row of schedule) {
      expect(row.principalDue).toBeGreaterThanOrEqual(0);
      expect(row.interestDue).toBeGreaterThanOrEqual(0);
    }
  });

  it("schedules due dates one month apart, starting a month after drawdown", () => {
    expect(schedule[0].dueDate.getUTCMonth()).toBe(1); // February
    expect(schedule[11].dueDate.getUTCFullYear()).toBe(2027);
  });

  it("splits principal evenly when the rate is zero", () => {
    const zeroRate = generateInstallmentSchedule({ ...baseParams, interestRatePct: 0, method: "AMORTIZING" });
    expect(sumPrincipal(zeroRate)).toBe(12_000);
    for (const row of zeroRate) {
      expect(row.interestDue).toBe(0);
      expect(row.principalDue).toBeCloseTo(1_000, 2);
    }
  });

  it("shortens the paying period by the grace months but still repays in full", () => {
    const withGrace = generateInstallmentSchedule({ ...baseParams, graceMonths: 3, method: "AMORTIZING" });
    expect(withGrace).toHaveLength(9);
    expect(sumPrincipal(withGrace)).toBe(12_000);
    // First payment lands after the 3-month grace period (Jan + 3 + 1 = May).
    expect(withGrace[0].dueDate.getUTCMonth()).toBe(4);
  });
});

describe("generateInstallmentSchedule — INTEREST_ONLY", () => {
  const schedule = generateInstallmentSchedule({ ...baseParams, method: "INTEREST_ONLY" });

  it("defers all principal to the final payment", () => {
    for (const row of schedule.slice(0, -1)) {
      expect(row.principalDue).toBe(0);
    }
    expect(schedule[schedule.length - 1].principalDue).toBe(12_000);
  });

  it("repays exactly the principal drawn", () => {
    expect(sumPrincipal(schedule)).toBe(12_000);
  });

  it("charges the same interest every period, since the balance never drops", () => {
    const interests = new Set(schedule.map((r) => r.interestDue));
    expect(interests.size).toBe(1);
    expect(schedule[0].interestDue).toBeCloseTo(120, 2);
  });

  it("costs more total interest than an amortizing schedule of the same size", () => {
    const amortizing = generateInstallmentSchedule({ ...baseParams, method: "AMORTIZING" });
    const totalIo = schedule.reduce((s, r) => s + r.interestDue, 0);
    const totalAm = amortizing.reduce((s, r) => s + r.interestDue, 0);
    expect(totalIo).toBeGreaterThan(totalAm);
  });
});

describe("generateInstallmentSchedule — BALLOON", () => {
  const schedule = generateInstallmentSchedule({ ...baseParams, method: "BALLOON" });

  it("repays exactly the principal drawn", () => {
    expect(sumPrincipal(schedule)).toBe(12_000);
  });

  it("defers a large final payment covering at least the balloon share", () => {
    const balloonShare = 12_000 * (BALLOON_PRINCIPAL_PCT / 100);
    const finalPrincipal = schedule[schedule.length - 1].principalDue;
    expect(finalPrincipal).toBeGreaterThanOrEqual(balloonShare);
  });

  it("makes the final principal payment far larger than the earlier ones", () => {
    const final = schedule[schedule.length - 1].principalDue;
    for (const row of schedule.slice(0, -1)) {
      expect(final).toBeGreaterThan(row.principalDue);
    }
  });

  it("keeps every payment non-negative", () => {
    for (const row of schedule) {
      expect(row.principalDue).toBeGreaterThanOrEqual(0);
      expect(row.interestDue).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("generateInstallmentSchedule — edge cases", () => {
  it("still emits one payment when grace consumes the whole term", () => {
    const schedule = generateInstallmentSchedule({
      ...baseParams,
      graceMonths: 12,
      method: "AMORTIZING",
    });
    expect(schedule).toHaveLength(1);
    expect(sumPrincipal(schedule)).toBe(12_000);
  });

  it("repays odd amounts exactly, without leaving a rounding remainder", () => {
    for (const amount of [1_000, 3_333.33, 99_999.99, 250_000]) {
      for (const method of ["AMORTIZING", "INTEREST_ONLY", "BALLOON"] as const) {
        const schedule = generateInstallmentSchedule({ ...baseParams, amount, method });
        expect(sumPrincipal(schedule), `${method} @ ${amount}`).toBeCloseTo(amount, 2);
      }
    }
  });

  it("handles a single-month term", () => {
    const schedule = generateInstallmentSchedule({ ...baseParams, termMonths: 1, method: "AMORTIZING" });
    expect(schedule).toHaveLength(1);
    expect(schedule[0].principalDue).toBe(12_000);
  });
});
