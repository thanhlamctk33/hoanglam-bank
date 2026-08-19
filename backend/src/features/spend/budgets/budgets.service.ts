import { BadRequestError, NotFoundError, PaymentRequiredError, UnprocessableEntityError } from "../../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../../shared/audit/audit.service";
import { createApprovalRequest } from "../../compliance/approvals/approval.service";
import { checkLimit } from "../../platform/subscription/subscription.service";
import { hasApprovalPower } from "../../../middleware/companyAdmin";
import { convertCurrency } from "../../../shared/fx/fx.service";
import * as budgetsRepo from "./budgets.repository";

/**
 * Business logic for budgets — every route in budgets.routes.ts is a thin
 * validate-then-call-this wrapper. All Prisma access goes through
 * budgets.repository.ts.
 */

/**
 * Budgets are funded by drawn-down credit sitting in the company's cash
 * accounts — a company can't allocate more into budgets than it actually
 * has. Excludes `excludeBudgetId` so editing/resubmitting a budget compares
 * against every *other* active/pending budget. Accounts and other budgets
 * can each be in a different currency than the one being checked, so
 * everything is converted (mock FX rates) into `currency` before comparing.
 */
async function checkBudgetWithinFunds(
  companyId: string,
  newAmount: number,
  currency: string,
  excludeBudgetId?: string
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const [accounts, otherBudgets] = await Promise.all([
    budgetsRepo.findAccountBalances(companyId),
    budgetsRepo.findAllocatedBudgets(companyId, excludeBudgetId),
  ]);

  const availableFunds = accounts.reduce((sum, account) => sum + convertCurrency(Number(account.balance), account.currency, currency), 0);
  const allocated = otherBudgets.reduce((sum, budget) => sum + convertCurrency(Number(budget.amount), budget.currency, currency), 0);

  if (allocated + newAmount > availableFunds) {
    return {
      allowed: false,
      message: `This budget would push total budgeted funds to ${(allocated + newAmount).toFixed(
        2
      )} ${currency}, above the ${availableFunds.toFixed(2)} ${currency} available in cash (converted at mock FX rates). Draw down more credit or lower the amount.`,
    };
  }
  return { allowed: true };
}

/** Runs the funds check and turns a failure into the standard 422. */
async function assertBudgetWithinFunds(companyId: string, amount: number, currency: string, excludeBudgetId?: string) {
  const fundsCheck = await checkBudgetWithinFunds(companyId, amount, currency, excludeBudgetId);
  if (!fundsCheck.allowed) {
    throw new UnprocessableEntityError(fundsCheck.message);
  }
}

/** Loads a company's own budget, or throws 404. */
async function requireOwnBudget(companyId: string, id: string) {
  const budget = await budgetsRepo.findOwnBudget(companyId, id);
  if (!budget) {
    throw new NotFoundError("Budget not found");
  }
  return budget;
}

export function listBudgets(companyId: string) {
  return budgetsRepo.findBudgetsByCompany(companyId);
}

export async function getBudget(companyId: string, id: string) {
  const budget = await budgetsRepo.findBudgetDetail(companyId, id);
  if (!budget) {
    throw new NotFoundError("Budget not found");
  }
  return budget;
}

export interface CreateBudgetParams {
  name: string;
  amount: number;
  currency: string;
  period: "MONTHLY" | "QUARTERLY" | "YEARLY";
  startDate?: Date;
  ownerId?: string;
}

export async function createBudget(companyId: string, userId: string, params: CreateBudgetParams) {
  const limitCheck = await checkLimit(companyId, "budget");
  if (!limitCheck.allowed) {
    throw new PaymentRequiredError(limitCheck.message);
  }

  if (params.ownerId) {
    const owner = await budgetsRepo.findOwnUser(companyId, params.ownerId);
    if (!owner) {
      throw new BadRequestError("Owner not found in this company");
    }
  }

  await assertBudgetWithinFunds(companyId, params.amount, params.currency);

  // Spend policy (Spend > Policies): a hard cap blocks the budget outright;
  // the approval threshold forces this into the approval queue even for a
  // requester who'd normally skip it (Admin/staff). Policy caps are always
  // set in USD, so the budget amount is converted to USD before comparing.
  const policy = await budgetsRepo.findSpendPolicy(companyId);
  const amountInUsd = convertCurrency(params.amount, params.currency, "USD");
  if (policy?.budgetAmountCap && amountInUsd > Number(policy.budgetAmountCap)) {
    throw new UnprocessableEntityError(
      `Exceeds your company's spend policy — budgets can't be created above ${Number(policy.budgetAmountCap).toFixed(
        2
      )} USD.`
    );
  }

  const policyForcesApproval = !!policy?.approvalThreshold && amountInUsd >= Number(policy.approvalThreshold);
  const actor = await budgetsRepo.findUserById(userId);
  const needsApproval = !hasApprovalPower(actor) || policyForcesApproval;

  const budget = await budgetsRepo.createBudget({
    ...params,
    status: needsApproval ? "PENDING" : "ACTIVE",
    companyId,
  });

  if (needsApproval) {
    await createApprovalRequest({
      targetType: "BUDGET",
      targetId: budget.id,
      companyId,
      requesterId: userId,
      metadata: { name: budget.name, amount: budget.amount.toString(), period: budget.period },
    });
  }

  await writeAuditLog({
    action: needsApproval ? "BUDGET_REQUESTED" : "BUDGET_CREATED",
    actorEmail: actor?.email ?? "unknown",
    targetType: "Budget",
    targetId: budget.id,
    metadata: { name: budget.name, amount: budget.amount.toString() },
  });

  return budget;
}

export async function updateBudgetAmount(companyId: string, id: string, amount: number, userId: string) {
  const budget = await requireOwnBudget(companyId, id);
  if (budget.status !== "ACTIVE") {
    throw new UnprocessableEntityError("This budget is not active yet");
  }

  await assertBudgetWithinFunds(companyId, amount, budget.currency, budget.id);

  const updated = await budgetsRepo.updateBudgetAmount(budget.id, amount);

  await writeAuditLog({
    action: "BUDGET_LIMIT_CHANGED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Budget",
    targetId: budget.id,
    metadata: { from: budget.amount.toString(), to: amount.toString() },
  });

  return updated;
}

export async function setBudgetStatus(companyId: string, id: string, status: "ACTIVE" | "FROZEN", userId: string) {
  const budget = await requireOwnBudget(companyId, id);
  if (budget.status !== "ACTIVE" && budget.status !== "FROZEN") {
    throw new UnprocessableEntityError("This budget is not active yet");
  }

  const updated = await budgetsRepo.updateBudgetStatus(budget.id, status);

  await writeAuditLog({
    action: status === "FROZEN" ? "BUDGET_FROZEN" : "BUDGET_UNFROZEN",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Budget",
    targetId: budget.id,
    metadata: { name: budget.name },
  });

  return updated;
}

// Testing only — a hard delete. Blocked while cards are still linked so a
// budget doesn't silently vanish out from under them; unassign/cancel those
// cards first. Also clears out any dangling approval request left behind if
// the budget was still PENDING.
export async function deleteBudget(companyId: string, id: string, userId: string) {
  const budget = await budgetsRepo.findOwnBudgetWithCards(companyId, id);
  if (!budget) {
    throw new NotFoundError("Budget not found");
  }
  if (budget.cards.length > 0) {
    throw new UnprocessableEntityError(
      `"${budget.name}" still has ${budget.cards.length} card${
        budget.cards.length === 1 ? "" : "s"
      } linked — unassign them first.`
    );
  }

  await budgetsRepo.deleteBudget(budget.id);
  await budgetsRepo.deleteApprovalRequestsForBudget(budget.id);

  await writeAuditLog({
    action: "BUDGET_DELETED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Budget",
    targetId: budget.id,
    metadata: { name: budget.name, amount: budget.amount.toString() },
  });
}

export interface ResubmitBudgetParams {
  name: string;
  amount: number;
}

export async function resubmitBudget(companyId: string, id: string, params: ResubmitBudgetParams) {
  const budget = await requireOwnBudget(companyId, id);
  if (budget.status !== "REJECTED") {
    throw new UnprocessableEntityError("Only rejected requests can be resubmitted");
  }

  await assertBudgetWithinFunds(companyId, params.amount, budget.currency, budget.id);

  const updated = await budgetsRepo.updateBudgetResubmit(budget.id, params);

  const request = await budgetsRepo.findLatestApprovalRequestForBudget(budget.id);
  if (request) {
    await budgetsRepo.resetApprovalRequestForResubmit(
      request.id,
      JSON.stringify({ name: params.name, amount: params.amount.toString(), period: budget.period })
    );
  }

  return updated;
}
