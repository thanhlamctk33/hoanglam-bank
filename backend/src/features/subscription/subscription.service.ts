import { PLANS, SubscriptionTier } from "./plans.config";
import { countActiveBudgets, countActiveCards, countClaimsSince, findCompanyTier } from "./subscription.repository";

export async function getCompanyTier(companyId: string): Promise<SubscriptionTier> {
  const company = await findCompanyTier(companyId);
  return (company?.tier as SubscriptionTier) ?? "FREE";
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export interface SubscriptionUsage {
  activeCards: number;
  activeBudgets: number;
  claimsThisMonth: number;
}

export async function getUsage(companyId: string): Promise<SubscriptionUsage> {
  const [activeCards, activeBudgets, claimsThisMonth] = await Promise.all([
    countActiveCards(companyId),
    countActiveBudgets(companyId),
    countClaimsSince(companyId, startOfMonth()),
  ]);
  return { activeCards, activeBudgets, claimsThisMonth };
}

type LimitedResource = "card" | "budget" | "claim";

const RESOURCE_LABEL: Record<LimitedResource, string> = {
  card: "active cards",
  budget: "active budgets",
  claim: "claims this month",
};

export async function checkLimit(
  companyId: string,
  resource: LimitedResource,
  additional = 1
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const tier = await getCompanyTier(companyId);
  const plan = PLANS[tier];
  const usage = await getUsage(companyId);

  const limit =
    resource === "card" ? plan.maxActiveCards : resource === "budget" ? plan.maxActiveBudgets : plan.maxClaimsPerMonth;
  const current =
    resource === "card" ? usage.activeCards : resource === "budget" ? usage.activeBudgets : usage.claimsThisMonth;

  if (limit !== null && current + additional > limit) {
    return {
      allowed: false,
      message: `Your ${plan.name} plan allows up to ${limit} ${RESOURCE_LABEL[resource]}. Upgrade your plan under Settings → Subscription to add more.`,
    };
  }
  return { allowed: true };
}
