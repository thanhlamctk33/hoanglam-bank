import { UnprocessableEntityError } from "../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../shared/audit/audit.service";
import { PLANS, PLAN_ORDER, SubscriptionTier } from "./plans.config";
import {
  countActiveBudgets,
  countActiveCards,
  countClaimsSince,
  findCompanySubscription,
  findCompanyTier,
  updateCompanyTier,
} from "./subscription.repository";

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

/** The Settings → Subscription overview: current tier, live usage, and the full plan catalogue. */
export async function getSubscriptionOverview(companyId: string) {
  const company = await findCompanySubscription(companyId);
  const tier = (company?.tier as SubscriptionTier) ?? "FREE";
  const usage = await getUsage(companyId);

  return {
    tier,
    plan: PLANS[tier],
    usage,
    updatedAt: company?.subscriptionUpdatedAt ?? null,
    plans: PLAN_ORDER.map((t) => PLANS[t]),
  };
}

export async function changeTier(companyId: string, nextTier: SubscriptionTier, userId: string) {
  const currentTier = await getCompanyTier(companyId);

  if (currentTier === nextTier) {
    throw new UnprocessableEntityError(`You're already on the ${PLANS[currentTier].name} plan.`);
  }

  // Downgrading is blocked while the company is still over the target plan's
  // caps — otherwise they'd sit above their limit with no way for the app to
  // reconcile which cards/budgets to disable.
  const nextPlan = PLANS[nextTier];
  const usage = await getUsage(companyId);
  const overCards = nextPlan.maxActiveCards !== null && usage.activeCards > nextPlan.maxActiveCards;
  const overBudgets = nextPlan.maxActiveBudgets !== null && usage.activeBudgets > nextPlan.maxActiveBudgets;
  const overClaims = nextPlan.maxClaimsPerMonth !== null && usage.claimsThisMonth > nextPlan.maxClaimsPerMonth;

  if (overCards || overBudgets || overClaims) {
    throw new UnprocessableEntityError(
      `Your current usage exceeds the ${nextPlan.name} plan's limits. Reduce active cards, budgets, or claims before switching down.`
    );
  }

  const company = await updateCompanyTier(companyId, nextTier);

  await writeAuditLog({
    action: "SUBSCRIPTION_CHANGED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Company",
    targetId: companyId,
    metadata: { from: currentTier, to: nextTier },
  });

  return {
    tier: company.tier,
    plan: PLANS[company.tier as SubscriptionTier],
    updatedAt: company.subscriptionUpdatedAt,
  };
}

/**
 * Testing convenience: drops straight back to FREE, skipping the usage checks
 * in changeTier above so a tester can always get to a clean slate.
 */
export async function resetTier(companyId: string, userId: string) {
  const currentTier = await getCompanyTier(companyId);
  const company = await updateCompanyTier(companyId, "FREE");

  await writeAuditLog({
    action: "SUBSCRIPTION_CHANGED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Company",
    targetId: companyId,
    metadata: { from: currentTier, to: "FREE", reason: "test_reset" },
  });

  return {
    tier: company.tier,
    plan: PLANS[company.tier as SubscriptionTier],
    updatedAt: company.subscriptionUpdatedAt,
  };
}
