import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";

/**
 * Thin Prisma wrappers for cards — cards.service.ts never touches `prisma`
 * itself. Card reads that feed the UI always use `cardListSelect` so the
 * shape stays identical across every route that returns a card.
 */

export const cardListSelect = {
  id: true,
  label: true,
  last4: true,
  expMonth: true,
  expYear: true,
  type: true,
  status: true,
  rejectionReason: true,
  currency: true,
  spendLimit: true,
  spent: true,
  createdAt: true,
  allowOnline: true,
  allowAtm: true,
  blockedCategories: true,
  owner: { select: { id: true, name: true } },
  budget: { select: { id: true, name: true } },
  account: { select: { id: true, name: true, accountNumber: true, currency: true } },
} as const;

// --- Cards -----------------------------------------------------------------------

export function findCardsByCompany(companyId: string) {
  return prisma.card.findMany({ where: { companyId }, select: cardListSelect, orderBy: { createdAt: "asc" } });
}

export function findOwnCard(companyId: string, cardId: string) {
  return prisma.card.findFirst({ where: { id: cardId, companyId } });
}

export function findCardRevealFields(companyId: string, cardId: string) {
  return prisma.card.findFirst({ where: { id: cardId, companyId }, select: { cardNumber: true, cvv: true } });
}

export function createCard(data: Prisma.CardUncheckedCreateInput) {
  return prisma.card.create({ data, select: cardListSelect });
}

export function updateCardStatus(cardId: string, status: "ACTIVE" | "FROZEN" | "CANCELLED") {
  return prisma.card.update({ where: { id: cardId }, data: { status }, select: cardListSelect });
}

export function updateCardResubmit(cardId: string, data: { label: string; spendLimit: number }) {
  return prisma.card.update({
    where: { id: cardId },
    data: { label: data.label, spendLimit: data.spendLimit, status: "PENDING", rejectionReason: null },
    select: cardListSelect,
  });
}

export function updateCardControls(
  cardId: string,
  data: { allowOnline: boolean; allowAtm: boolean; blockedCategories: string[] }
) {
  return prisma.card.update({
    where: { id: cardId },
    data: {
      allowOnline: data.allowOnline,
      allowAtm: data.allowAtm,
      blockedCategories: data.blockedCategories.length ? JSON.stringify(data.blockedCategories) : null,
    },
    select: cardListSelect,
  });
}

export function deleteCard(cardId: string) {
  return prisma.card.delete({ where: { id: cardId } });
}

// --- Card <-> budget assignment ---------------------------------------------------

export function findActiveCardSpendLimits(budgetId: string, excludeCardId?: string) {
  return prisma.card.findMany({
    where: {
      budgetId,
      status: { in: ["ACTIVE", "PENDING"] },
      ...(excludeCardId ? { id: { not: excludeCardId } } : {}),
    },
    select: { spendLimit: true },
  });
}

// --- Users -------------------------------------------------------------------------

export function findAssignableUsers(companyId: string) {
  return prisma.user.findMany({
    where: { companyId, isStaff: false },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
}

export function findUserById(userId: string) {
  return prisma.user.findUnique({ where: { id: userId } });
}

export function findOwnUser(companyId: string, ownerId: string) {
  return prisma.user.findFirst({ where: { id: ownerId, companyId } });
}

// --- Budgets / accounts / spend policy ----------------------------------------------

export function findOwnBudget(companyId: string, budgetId: string) {
  return prisma.budget.findFirst({ where: { id: budgetId, companyId } });
}

export function findBudgetById(budgetId: string) {
  return prisma.budget.findUnique({ where: { id: budgetId } });
}

export function findOwnAccount(companyId: string, accountId: string) {
  return prisma.account.findFirst({ where: { id: accountId, companyId } });
}

export function findSpendPolicy(companyId: string) {
  return prisma.spendPolicy.findUnique({ where: { companyId } });
}

// --- Approval requests (card side) --------------------------------------------------

export function findLatestApprovalRequestForCard(cardId: string) {
  return prisma.approvalRequest.findFirst({ where: { targetType: "CARD", targetId: cardId }, orderBy: { createdAt: "desc" } });
}

export function resetApprovalRequestForResubmit(id: string, metadata: string) {
  return prisma.approvalRequest.update({
    where: { id },
    data: { status: "PENDING", reason: null, reviewerId: null, reviewedAt: null, metadata },
  });
}

export function deleteApprovalRequestsForCard(cardId: string) {
  return prisma.approvalRequest.deleteMany({ where: { targetType: "CARD", targetId: cardId } });
}

// --- Simulated purchase (batched write) ---------------------------------------------

/** Runs a batch of independent writes atomically — used by the simulate-purchase route. */
export function runBatchedWrites(writeOperations: Prisma.PrismaPromise<unknown>[]): Promise<unknown[]> {
  return prisma.$transaction(writeOperations);
}

export function incrementCardSpent(cardId: string, amount: number) {
  return prisma.card.update({ where: { id: cardId }, data: { spent: { increment: amount } }, select: cardListSelect });
}

export function decrementAccountBalance(accountId: string, amount: number) {
  return prisma.account.update({ where: { id: accountId }, data: { balance: { decrement: amount } } });
}

export function createCardPurchaseTransaction(data: Prisma.TransactionUncheckedCreateInput) {
  return prisma.transaction.create({ data });
}

export function incrementBudgetSpent(budgetId: string, amount: number) {
  return prisma.budget.update({ where: { id: budgetId }, data: { spent: { increment: amount } } });
}
