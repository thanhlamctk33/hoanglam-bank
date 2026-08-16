import { describe, expect, it } from "vitest";
import { convertCurrency, FX_RATES_PER_USD, FX_FEE_PCT } from "./fx.service";

describe("convertCurrency", () => {
  it("returns the amount unchanged when both sides are the same currency", () => {
    expect(convertCurrency(1234.56, "USD", "USD")).toBe(1234.56);
    expect(convertCurrency(1234.56, "EUR", "EUR")).toBeCloseTo(1234.56, 10);
  });

  it("converts from USD using the rate table directly", () => {
    expect(convertCurrency(100, "USD", "EUR")).toBeCloseTo(92, 10);
    expect(convertCurrency(100, "USD", "VND")).toBeCloseTo(2_545_000, 10);
  });

  it("converts back to USD by dividing by the source rate", () => {
    expect(convertCurrency(92, "EUR", "USD")).toBeCloseTo(100, 10);
  });

  it("round-trips through a third currency without drift", () => {
    const there = convertCurrency(500, "GBP", "JPY");
    expect(convertCurrency(there, "JPY", "GBP")).toBeCloseTo(500, 8);
  });

  it("cross-converts two non-USD currencies via USD", () => {
    // 100 EUR -> USD is 100/0.92; that times the GBP rate is the expected result.
    const expected = (100 / FX_RATES_PER_USD.EUR) * FX_RATES_PER_USD.GBP;
    expect(convertCurrency(100, "EUR", "GBP")).toBeCloseTo(expected, 10);
  });

  it("treats an unknown currency code as 1:1 rather than producing NaN", () => {
    // Guards the `?? 1` fallbacks — a bad code must never poison a balance
    // with NaN, which would silently corrupt every downstream sum.
    expect(convertCurrency(100, "XXX", "USD")).toBe(100);
    expect(convertCurrency(100, "USD", "XXX")).toBe(100);
    expect(Number.isNaN(convertCurrency(100, "XXX", "YYY"))).toBe(false);
  });

  it("converts zero to zero in every direction", () => {
    expect(convertCurrency(0, "USD", "JPY")).toBe(0);
    expect(convertCurrency(0, "KRW", "EUR")).toBe(0);
  });
});

describe("FX rate table", () => {
  it("anchors USD at exactly 1", () => {
    expect(FX_RATES_PER_USD.USD).toBe(1);
  });

  it("has a positive, finite rate for every listed currency", () => {
    for (const [code, rate] of Object.entries(FX_RATES_PER_USD)) {
      expect(rate, `${code} rate`).toBeGreaterThan(0);
      expect(Number.isFinite(rate), `${code} rate`).toBe(true);
    }
  });

  it("keeps the FX fee a sane percentage", () => {
    expect(FX_FEE_PCT).toBeGreaterThan(0);
    expect(FX_FEE_PCT).toBeLessThan(100);
  });
});
