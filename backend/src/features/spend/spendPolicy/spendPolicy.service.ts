import { writeAuditLog, resolveActorEmail } from "../../../shared/audit/audit.service";
import { DEFAULT_CLAIM_FLAG_LIMIT, DEFAULT_VELOCITY_WINDOW_MINUTES } from "./spendPolicy.config";
import * as spendPolicyRepo from "./spendPolicy.repository";

/**
 * Business logic for the company spend policy — every route in
 * spendPolicy.routes.ts is a thin validate-then-call-this wrapper. All
 * Prisma access goes through spendPolicy.repository.ts.
 */

/**
 * One SpendPolicy row per company, created lazily the first time anyone
 * loads Spend > Policies — there's nothing to configure until then, so a
 * migration-time backfill isn't needed.
 */
export async function getOrCreatePolicy(companyId: string) {
  const existing = await spendPolicyRepo.findPolicy(companyId);
  if (existing) return existing;
  return spendPolicyRepo.createPolicy(companyId);
}

export interface UpdateSpendPolicyParams {
  cardSpendLimitCap: number | null;
  budgetAmountCap: number | null;
  approvalThreshold: number | null;
  claimFlagLimit: number;
  velocityMaxCount?: number | null;
  velocityWindowMinutes?: number;
}

export async function updatePolicy(companyId: string, userId: string, params: UpdateSpendPolicyParams) {
  const { cardSpendLimitCap, budgetAmountCap, approvalThreshold, claimFlagLimit, velocityMaxCount, velocityWindowMinutes } =
    params;

  const policy = await spendPolicyRepo.upsertPolicy(
    companyId,
    {
      companyId,
      cardSpendLimitCap,
      budgetAmountCap,
      approvalThreshold,
      claimFlagLimit,
      velocityMaxCount: velocityMaxCount ?? null,
      ...(velocityWindowMinutes !== undefined ? { velocityWindowMinutes } : {}),
      updatedById: userId,
    },
    {
      cardSpendLimitCap,
      budgetAmountCap,
      approvalThreshold,
      claimFlagLimit,
      // Omitted velocity fields keep their existing value on update, unlike
      // the create branch above where there's nothing to preserve.
      ...(velocityMaxCount !== undefined ? { velocityMaxCount } : {}),
      ...(velocityWindowMinutes !== undefined ? { velocityWindowMinutes } : {}),
      updatedById: userId,
    }
  );

  await writeAuditLog({
    action: "SPEND_POLICY_UPDATED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "SpendPolicy",
    targetId: policy.id,
    metadata: {
      cardSpendLimitCap: cardSpendLimitCap?.toString() ?? "none",
      budgetAmountCap: budgetAmountCap?.toString() ?? "none",
      approvalThreshold: approvalThreshold?.toString() ?? "none",
      claimFlagLimit: claimFlagLimit.toString(),
      velocityMaxCount: velocityMaxCount?.toString() ?? "none",
    },
  });

  return policy;
}

/**
 * Restores this company's spend policy to the out-of-the-box defaults: no
 * card/budget caps, no forced approval threshold, claim flag limit back to
 * its default. A real settings action (not a testing-only helper) — an Admin
 * might use this after experimenting with limits to undo everything at once
 * instead of clearing each field by hand.
 */
export async function resetPolicy(companyId: string, userId: string) {
  const defaults = {
    cardSpendLimitCap: null,
    budgetAmountCap: null,
    approvalThreshold: null,
    claimFlagLimit: DEFAULT_CLAIM_FLAG_LIMIT,
    velocityMaxCount: null,
  };

  const policy = await spendPolicyRepo.upsertPolicy(
    companyId,
    { companyId, ...defaults, updatedById: userId },
    { ...defaults, velocityWindowMinutes: DEFAULT_VELOCITY_WINDOW_MINUTES, updatedById: userId }
  );

  await writeAuditLog({
    action: "SPEND_POLICY_RESET_TO_DEFAULT",
    actorEmail: await resolveActorEmail(userId),
    targetType: "SpendPolicy",
    targetId: policy.id,
  });

  return policy;
}
