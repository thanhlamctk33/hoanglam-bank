export type SubscriptionTier = "FREE" | "PRO" | "BUSINESS";

export interface PlanDefinition {
  tier: SubscriptionTier;
  name: string;
  priceMonthly: number;
  /** null = unlimited */
  maxActiveCards: number | null;
  /** null = unlimited */
  maxActiveBudgets: number | null;
  /** null = unlimited; resets every calendar month */
  maxClaimsPerMonth: number | null;
  /** % discount applied to utility bill payments */
  spendDiscountPct: number;
  /** % discount applied to wire & FX transfer fees */
  transferDiscountPct: number;
  features: string[];
}

export const PLAN_ORDER: SubscriptionTier[] = ["FREE", "PRO", "BUSINESS"];

export const PLANS: Record<SubscriptionTier, PlanDefinition> = {
  FREE: {
    tier: "FREE",
    name: "Free",
    priceMonthly: 0,
    maxActiveCards: 3,
    maxActiveBudgets: 2,
    maxClaimsPerMonth: 5,
    spendDiscountPct: 0,
    transferDiscountPct: 0,
    features: [
      "Up to 3 active cards",
      "Up to 2 active budgets",
      "5 expense claims per month",
      "Standard support",
    ],
  },
  PRO: {
    tier: "PRO",
    name: "Pro",
    priceMonthly: 49,
    maxActiveCards: 15,
    maxActiveBudgets: 10,
    maxClaimsPerMonth: 50,
    spendDiscountPct: 1,
    transferDiscountPct: 10,
    features: [
      "Up to 15 active cards",
      "Up to 10 active budgets",
      "50 expense claims per month",
      "1% discount on bill payments",
      "10% discount on wire & FX transfer fees",
      "Priority support",
    ],
  },
  BUSINESS: {
    tier: "BUSINESS",
    name: "Business",
    priceMonthly: 199,
    maxActiveCards: null,
    maxActiveBudgets: null,
    maxClaimsPerMonth: null,
    spendDiscountPct: 2,
    transferDiscountPct: 25,
    features: [
      "Unlimited cards",
      "Unlimited budgets",
      "Unlimited expense claims",
      "2% discount on bill payments",
      "25% discount on wire & FX transfer fees",
      "Dedicated account manager",
    ],
  },
};
