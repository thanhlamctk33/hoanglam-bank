/**
 * Mock exchange rates (units per 1 USD) for the FX transfer simulation.
 * Not live rates — this is a demo app with no real market data feed.
 */
export const FX_RATES_PER_USD: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 155.3,
  VND: 25450,
  SGD: 1.34,
  AUD: 1.52,
  CAD: 1.36,
  CNY: 7.24,
  KRW: 1370,
};

export const FX_CURRENCIES = Object.keys(FX_RATES_PER_USD) as [string, ...string[]];

/** Flat mock fee/spread charged on FX transfers, as a % of the sent amount (display only, not deducted). */
export const FX_FEE_PCT = 0.5;

/** Converts an amount from one currency to another via the USD mock rate table. */
export function convertCurrency(amount: number, from: string, to: string): number {
  const fromRate = FX_RATES_PER_USD[from] ?? 1;
  const toRate = FX_RATES_PER_USD[to] ?? 1;
  return (amount / fromRate) * toRate;
}
