import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

/**
 * All direct Prisma access for the Ops/staff admin console lives here —
 * admin.service.ts never touches `prisma` itself. Grouped by the same
 * sections as admin.routes.ts / admin.service.ts (customers, accounts,
 * claims, approval requests, KYB, credit applies).
 */

// --- Customers ---------------------------------------------------------------

/** Every company that isn't a staff/bank company itself — the Ops customer list. */
export function findCustomerCompanies() {
  return prisma.company.findMany({
    where: { users: { none: { isStaff: true } } },
    include: {
      users: { select: { id: true, name: true, email: true, role: true } },
      accounts: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

/** Full "manage this company" detail view — profile, KYB, cards/budgets/claims. */
export function findCustomerCompanyDetail(companyId: string) {
  return prisma.company.findFirst({
    where: { id: companyId, users: { none: { isStaff: true } } },
    include: {
      users: { select: { id: true, name: true, email: true, role: true } },
      accounts: true,
      businessProfile: true,
      beneficialOwners: { orderBy: { createdAt: "asc" } },
      cards: { orderBy: { createdAt: "desc" } },
      budgets: { orderBy: { createdAt: "desc" } },
      claims: { orderBy: { submittedAt: "desc" }, take: 50 },
    },
  });
}

// --- Accounts / transactions ---------------------------------------------------

export function findAccountById(accountId: string) {
  return prisma.account.findUnique({ where: { id: accountId } });
}

export function setAccountFrozen(accountId: string, frozen: boolean) {
  return prisma.account.update({ where: { id: accountId }, data: { frozen } });
}

/** Most recent 200 transactions across every company, for the Ops transactions feed. */
export function findRecentTransactions() {
  return prisma.transaction.findMany({
    include: { account: { include: { company: { select: { id: true, name: true } } } } },
    orderBy: { date: "desc" },
    take: 200,
  });
}

// --- Claims --------------------------------------------------------------------

export function countClaims(where: Prisma.ClaimWhereInput) {
  return prisma.claim.count({ where });
}

export function findClaims(where: Prisma.ClaimWhereInput, page?: { skip: number; take: number }) {
  return prisma.claim.findMany({
    where,
    include: {
      company: { select: { id: true, name: true } },
      submittedBy: { select: { id: true, name: true } },
    },
    orderBy: { submittedAt: "desc" },
    ...(page ? { skip: page.skip, take: page.take } : {}),
  });
}

export function findClaimById(claimId: string) {
  return prisma.claim.findUnique({ where: { id: claimId } });
}

export function updateClaimStatus(claimId: string, status: "PENDING" | "APPROVED" | "REJECTED") {
  return prisma.claim.update({ where: { id: claimId }, data: { status } });
}

export function deleteClaim(claimId: string) {
  return prisma.claim.delete({ where: { id: claimId } });
}

// --- Audit log -------------------------------------------------------------------

export function findRecentAuditLogEntries() {
  return prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
}

// --- Approval requests (card/budget maker-checker) --------------------------------

export function findApprovalRequests(where: Prisma.ApprovalRequestWhereInput) {
  return prisma.approvalRequest.findMany({ where, orderBy: { createdAt: "desc" }, take: 500 });
}

export function findApprovalRequestById(id: string) {
  return prisma.approvalRequest.findUnique({ where: { id } });
}

export function approveApprovalRequestRecord(id: string, reviewerId: string) {
  return prisma.approvalRequest.update({
    where: { id },
    data: { status: "APPROVED", reviewerId, reviewedAt: new Date() },
  });
}

export function rejectApprovalRequestRecord(id: string, reviewerId: string, reason: string) {
  return prisma.approvalRequest.update({
    where: { id },
    data: { status: "REJECTED", reason, reviewerId, reviewedAt: new Date() },
  });
}

export function deleteApprovalRequestRecord(id: string) {
  return prisma.approvalRequest.delete({ where: { id } });
}

export function activateCard(cardId: string) {
  return prisma.card.update({ where: { id: cardId }, data: { status: "ACTIVE" } });
}

export function activateBudget(budgetId: string) {
  return prisma.budget.update({ where: { id: budgetId }, data: { status: "ACTIVE" } });
}

export function rejectCard(cardId: string, rejectionReason: string) {
  return prisma.card.update({ where: { id: cardId }, data: { status: "REJECTED", rejectionReason } });
}

export function rejectBudget(budgetId: string, rejectionReason: string) {
  return prisma.budget.update({ where: { id: budgetId }, data: { status: "REJECTED", rejectionReason } });
}

/** Cascades a deleted approval request to its target — no-op if the card/budget is already gone. */
export function deleteCardByApprovalTarget(cardId: string) {
  return prisma.card.deleteMany({ where: { id: cardId } });
}

export function deleteBudgetByApprovalTarget(budgetId: string) {
  return prisma.budget.deleteMany({ where: { id: budgetId } });
}

// --- Shared lookups (approval requests + credit applies enrichment) ---------------

export function findUsersByIds(ids: string[]) {
  return prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
}

export function findCompaniesByIds(ids: string[]) {
  return prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
}

// --- KYB review ------------------------------------------------------------------

export function findKybCompanies(where: Prisma.CompanyWhereInput) {
  return prisma.company.findMany({
    where,
    select: {
      id: true,
      name: true,
      kybStatus: true,
      kybSubmittedAt: true,
      kybReviewedAt: true,
      kybRejectionReason: true,
      businessProfile: true,
      _count: { select: { beneficialOwners: true, kybDocuments: true } },
    },
    orderBy: { kybSubmittedAt: "desc" },
  });
}

export function findKybCompanyDetail(companyId: string) {
  return prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      kybStatus: true,
      kybSubmittedAt: true,
      kybReviewedAt: true,
      kybRejectionReason: true,
      businessProfile: true,
      beneficialOwners: { orderBy: { createdAt: "asc" } },
      kybDocuments: { orderBy: { createdAt: "desc" } },
    },
  });
}

export function findCompanyById(companyId: string) {
  return prisma.company.findUnique({ where: { id: companyId } });
}

export function updateCompanyKybDecision(
  companyId: string,
  data: { kybStatus: "APPROVED" | "REJECTED" | "NEEDS_INFO"; kybRejectionReason: string | null }
) {
  return prisma.company.update({
    where: { id: companyId },
    data: { ...data, kybReviewedAt: new Date() },
  });
}

// --- Credit applies (maker-checker) -----------------------------------------------

export function findCreditApplies(where: Prisma.CreditApplyWhereInput | undefined) {
  return prisma.creditApply.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
}

export function findCreditApplyById(id: string) {
  return prisma.creditApply.findUnique({ where: { id } });
}

export function createCreditApplyRecord(data: {
  companyId: string;
  requestedAmount: number;
  makerNote?: string;
  makerId: string;
}) {
  return prisma.creditApply.create({ data });
}

export function forwardCreditApplyRecord(id: string, makerId: string, makerNote?: string) {
  return prisma.creditApply.update({
    where: { id },
    data: { status: "PENDING_CHECKER", makerId, makerNote },
  });
}

export function approveCreditApplyRecord(
  id: string,
  data: {
    approvedAmount: number;
    offeredInterestRatePct: number;
    offeredTermMonths: number;
    checkerId: string;
    checkerNote?: string;
  }
) {
  return prisma.creditApply.update({
    where: { id },
    data: { status: "APPROVED", ...data, decidedAt: new Date() },
  });
}

export function rejectCreditApplyRecord(id: string, checkerId: string, checkerNote: string) {
  return prisma.creditApply.update({
    where: { id },
    data: { status: "REJECTED", checkerId, checkerNote, decidedAt: new Date() },
  });
}

// --- Customer detail extras (credit line, drawdowns, repayments) -----------------

export function findCreditAppliesByCompany(companyId: string) {
  return prisma.creditApply.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}

export function findDrawdownsByCompany(companyId: string) {
  return prisma.drawdown.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}

export function findRepaymentsByCompany(companyId: string) {
  return prisma.repayment.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}
