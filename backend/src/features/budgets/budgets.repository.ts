import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

/**
 * Thin Prisma wrappers for budgets — budgets.service.ts never touches
 * `prisma` itself. Budget reads that feed the UI always include the owner
 * so the shape stays identical across every route that returns a budget.
 */

const budgetInclude = { owner: { select: { id: true, name: true } } } as const;

export function findBudgetsByCompany(companyId: string) {
  return prisma.budget.findMany({ where: { companyId }, include: budgetInclude, orderBy: { createdAt: "asc" } });
}

export function findBudgetDetail(companyId: string, id: string) {
  return prisma.budget.findFirst({
    where: { id, companyId },
    include: {
      ...budgetInclude,
      cards: {
        select: { id: true, label: true, type: true, status: true, spendLimit: true, spent: true, currency: true },
      },
    },
  });
}

export function findOwnBudget(companyId: string, id: string) {
  return prisma.budget.findFirst({ where: { id, companyId } });
}

export function findOwnBudgetWithCards(companyId: string, id: string) {
  return prisma.budget.findFirst({ where: { id, companyId }, include: { cards: { select: { id: true } } } });
}

export function createBudget(data: Prisma.BudgetUncheckedCreateInput) {
  return prisma.budget.create({ data, include: budgetInclude });
}

export function updateBudgetAmount(id: string, amount: number) {
  return prisma.budget.update({ where: { id }, data: { amount }, include: budgetInclude });
}

export function updateBudgetStatus(id: string, status: "ACTIVE" | "FROZEN") {
  return prisma.budget.update({ where: { id }, data: { status }, include: budgetInclude });
}

export function updateBudgetResubmit(id: string, data: { name: string; amount: number }) {
  return prisma.budget.update({
    where: { id },
    data: { name: data.name, amount: data.amount, status: "PENDING", rejectionReason: null },
    include: budgetInclude,
  });
}

export function deleteBudget(id: string) {
  return prisma.budget.delete({ where: { id } });
}

// --- Funding checks -------------------------------------------------------------

export function findAccountBalances(companyId: string) {
  return prisma.account.findMany({ where: { companyId }, select: { balance: true, currency: true } });
}

export function findAllocatedBudgets(companyId: string, excludeBudgetId?: string) {
  return prisma.budget.findMany({
    where: {
      companyId,
      status: { in: ["ACTIVE", "PENDING"] },
      id: excludeBudgetId ? { not: excludeBudgetId } : undefined,
    },
    select: { amount: true, currency: true },
  });
}

// --- Related lookups --------------------------------------------------------------

export function findOwnUser(companyId: string, userId: string) {
  return prisma.user.findFirst({ where: { id: userId, companyId } });
}

export function findUserById(userId: string) {
  return prisma.user.findUnique({ where: { id: userId } });
}

export function findSpendPolicy(companyId: string) {
  return prisma.spendPolicy.findUnique({ where: { companyId } });
}

// --- Approval requests (budget side) -------------------------------------------------

export function findLatestApprovalRequestForBudget(budgetId: string) {
  return prisma.approvalRequest.findFirst({
    where: { targetType: "BUDGET", targetId: budgetId },
    orderBy: { createdAt: "desc" },
  });
}

export function resetApprovalRequestForResubmit(id: string, metadata: string) {
  return prisma.approvalRequest.update({
    where: { id },
    data: { status: "PENDING", reason: null, reviewerId: null, reviewedAt: null, metadata },
  });
}

export function deleteApprovalRequestsForBudget(budgetId: string) {
  return prisma.approvalRequest.deleteMany({ where: { targetType: "BUDGET", targetId: budgetId } });
}
