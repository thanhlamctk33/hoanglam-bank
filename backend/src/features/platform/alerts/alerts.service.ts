import { NotFoundError } from "../../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../../shared/audit/audit.service";
import * as alertsRepo from "./alerts.repository";

/**
 * Business logic for user-configurable alert thresholds, on top of the fixed
 * low-balance/large-transaction heuristics elsewhere in the app. AlertRule
 * has no Prisma relation to Account (raw accountId column, null = applies to
 * every account on the company) — same no-relation convention as the other
 * financial models in this codebase.
 *
 * Every route in alerts.routes.ts is a thin validate-then-call-this wrapper;
 * all Prisma access goes through alerts.repository.ts. The rules themselves
 * are evaluated in features/notifications.
 */

export function listRules(companyId: string) {
  return alertsRepo.findRulesByCompany(companyId);
}

/** Loads a company's own rule, or throws 404. */
async function requireOwnRule(companyId: string, id: string) {
  const rule = await alertsRepo.findOwnRule(companyId, id);
  if (!rule) {
    throw new NotFoundError("Alert rule not found");
  }
  return rule;
}

export interface CreateAlertRuleParams {
  type: "LOW_BALANCE" | "LARGE_TRANSACTION";
  threshold: number;
  accountId?: string;
}

export async function createRule(companyId: string, userId: string, params: CreateAlertRuleParams) {
  const { type, threshold, accountId } = params;

  if (accountId) {
    const account = await alertsRepo.findOwnAccount(companyId, accountId);
    if (!account) {
      throw new NotFoundError("Account not found");
    }
  }

  const rule = await alertsRepo.createRule({ companyId, type, threshold, accountId, createdById: userId });

  await writeAuditLog({
    action: "ALERT_RULE_CREATED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "AlertRule",
    targetId: rule.id,
    metadata: { type, threshold: threshold.toString(), accountId: accountId ?? "all" },
  });

  return rule;
}

export async function setRuleActive(companyId: string, id: string, active: boolean) {
  const rule = await requireOwnRule(companyId, id);
  return alertsRepo.setRuleActive(rule.id, active);
}

export async function deleteRule(companyId: string, id: string) {
  const rule = await requireOwnRule(companyId, id);
  await alertsRepo.deleteRule(rule.id);
}
