import { describe, expect, it, vi } from "vitest";

// transfers.service reaches Prisma through its repository and several shared
// services; all of them are mocked so this stays a pure unit test of the fee
// arithmetic.
vi.mock("./transfers.repository", () => ({}));
vi.mock("../../shared/audit/audit.service", () => ({ writeAuditLog: vi.fn(), resolveActorEmail: vi.fn() }));
vi.mock("../../shared/fraud/fraud.service", () => ({ checkVelocity: vi.fn(), flagIfAnomalous: vi.fn() }));
vi.mock("../kyb/kyb.service", () => ({ checkTransactionAllowed: vi.fn() }));
vi.mock("../subscription/subscription.service", () => ({ getCompanyTier: vi.fn() }));

import { applyTransferDiscount } from "./transfers.service";
import { PLANS } from "../../platform/subscription/plans.config";
import { FX_FEE_PCT } from "../../../shared/fx/fx.service";

describe("applyTransferDiscount", () => {
  it("leaves the fee untouched on a plan with no discount", () => {
    expect(applyTransferDiscount(25, 0)).toEqual({ baseFeeAmount: 25, discountAmount: 0, feeAmount: 25 });
  });

  it("applies a percentage discount to the base fee", () => {
    expect(applyTransferDiscount(25, 20)).toEqual({ baseFeeAmount: 25, discountAmount: 5, feeAmount: 20 });
  });

  it("waives the fee entirely at 100%", () => {
    expect(applyTransferDiscount(25, 100)).toEqual({ baseFeeAmount: 25, discountAmount: 25, feeAmount: 0 });
  });

  it("rounds both the discount and the resulting fee to cents", () => {
    const { discountAmount, feeAmount } = applyTransferDiscount(33.33, 15);
    expect(discountAmount).toBe(5);
    expect(feeAmount).toBe(28.33);
  });

  it("keeps discount + fee equal to the base fee", () => {
    // The invariant that matters: a rounding bug must never make the customer
    // pay more (or the bank collect less) than the quoted base fee.
    for (const discountPct of [0, 7, 12.5, 20, 33, 50, 99]) {
      for (const baseFee of [25, 33.33, 0.07, 1234.56]) {
        const { baseFeeAmount, discountAmount, feeAmount } = applyTransferDiscount(baseFee, discountPct);
        expect(discountAmount + feeAmount).toBeCloseTo(baseFeeAmount, 2);
      }
    }
  });

  it("never produces a negative fee", () => {
    for (const discountPct of [0, 25, 50, 100]) {
      expect(applyTransferDiscount(0.01, discountPct).feeAmount).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles a zero base fee without dividing by anything", () => {
    expect(applyTransferDiscount(0, 50)).toEqual({ baseFeeAmount: 0, discountAmount: 0, feeAmount: 0 });
  });
});

describe("plan-based transfer pricing", () => {
  it("charges every plan no more than the undiscounted wire fee", () => {
    const WIRE_FEE_FLAT = 25;
    for (const plan of Object.values(PLANS)) {
      const { feeAmount } = applyTransferDiscount(WIRE_FEE_FLAT, plan.transferDiscountPct);
      expect(feeAmount, `${plan.name} wire fee`).toBeLessThanOrEqual(WIRE_FEE_FLAT);
      expect(feeAmount, `${plan.name} wire fee`).toBeGreaterThanOrEqual(0);
    }
  });

  it("never charges a higher-tier plan more than a lower-tier one", () => {
    const feeFor = (discountPct: number) => applyTransferDiscount(25, discountPct).feeAmount;
    expect(feeFor(PLANS.PRO.transferDiscountPct)).toBeLessThanOrEqual(feeFor(PLANS.FREE.transferDiscountPct));
    expect(feeFor(PLANS.BUSINESS.transferDiscountPct)).toBeLessThanOrEqual(feeFor(PLANS.PRO.transferDiscountPct));
  });

  it("computes the FX percentage fee the same way the route does", () => {
    const amount = 10_000;
    const baseFee = Math.round(((amount * FX_FEE_PCT) / 100) * 100) / 100;
    expect(baseFee).toBe(50);
    expect(applyTransferDiscount(baseFee, PLANS.FREE.transferDiscountPct).feeAmount).toBe(50);
  });
});
