import { Prisma } from "@prisma/client";
import { ForbiddenError, NotFoundError, UnprocessableEntityError } from "../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../shared/audit/audit.service";
import { getActiveCreditApply, availableAmount, getCreditRiskSnapshot, getCreditMonitoring } from "../credit/credit.service";
import { MIN_CREDIT_APPLY_AMOUNT, DEFAULT_INTEREST_RATE_PCT, DEFAULT_TERM_MONTHS } from "../credit/lending.config";
import * as adminRepo from "./admin.repository";

/**
 * Business logic for the Ops/staff admin console — every route in
 * admin.routes.ts is a thin validate-then-call-this wrapper. All Prisma
 * access goes through admin.repository.ts.
 */

// --- Customers ---------------------------------------------------------------

export function listCustomers() {
  return adminRepo.findCustomerCompanies();
}

export async function getCustomerDetail(companyId: string) {
  const company = await adminRepo.findCustomerCompanyDetail(companyId);
  if (!company) {
    throw new NotFoundError("Company not found");
  }

  const creditApplies = await adminRepo.findCreditAppliesByCompany(company.id);
  const activeCreditApply =
    creditApplies.find((c) => c.status === "PENDING_MAKER" || c.status === "PENDING_CHECKER" || c.status === "APPROVED") ??
    null;
  const [drawdowns, repayments, monitoring] = await Promise.all([
    adminRepo.findDrawdownsByCompany(company.id),
    adminRepo.findRepaymentsByCompany(company.id),
    activeCreditApply && activeCreditApply.status === "APPROVED" ? getCreditMonitoring(activeCreditApply.id) : null,
  ]);

  return {
    company,
    creditApplies,
    availableAmount: availableAmount(activeCreditApply ?? null),
    monitoring,
    drawdowns,
    repayments,
  };
}

// --- Accounts / transactions ---------------------------------------------------

export async function setAccountFrozen(accountId: string, frozen: boolean, actorUserId: string) {
  const account = await adminRepo.findAccountById(accountId);
  if (!account) {
    throw new NotFoundError("Account not found");
  }

  const updated = await adminRepo.setAccountFrozen(account.id, frozen);

  await writeAuditLog({
    action: frozen ? "ACCOUNT_FROZEN" : "ACCOUNT_UNFROZEN",
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: "Account",
    targetId: account.id,
    metadata: { accountNumber: account.accountNumber },
  });

  return updated;
}

export function listRecentTransactions() {
  return adminRepo.findRecentTransactions();
}

// --- Claims --------------------------------------------------------------------

export interface ListClaimsParams {
  status?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function listClaims({ status, q, page, pageSize }: ListClaimsParams) {
  const where: Prisma.ClaimWhereInput = {
    ...(status ? { status: status as "PENDING" | "APPROVED" | "REJECTED" } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { company: { name: { contains: q, mode: "insensitive" as const } } },
            { submittedBy: { name: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const total = await adminRepo.countClaims(where);
  const claims = await adminRepo.findClaims(where, page && pageSize ? { skip: (page - 1) * pageSize, take: pageSize } : undefined);
  return { claims, total };
}

export async function updateClaimStatus(claimId: string, status: "PENDING" | "APPROVED" | "REJECTED", actorUserId: string) {
  const claim = await adminRepo.findClaimById(claimId);
  if (!claim) {
    throw new NotFoundError("Claim not found");
  }

  const updated = await adminRepo.updateClaimStatus(claim.id, status);

  await writeAuditLog({
    action: `CLAIM_${status}`,
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: "Claim",
    targetId: claim.id,
    metadata: { title: claim.title, amount: claim.amount.toString() },
  });

  return updated;
}

export async function deleteClaim(claimId: string, actorUserId: string) {
  const claim = await adminRepo.findClaimById(claimId);
  if (!claim) {
    throw new NotFoundError("Claim not found");
  }

  await adminRepo.deleteClaim(claim.id);

  await writeAuditLog({
    action: "CLAIM_DELETED",
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: "Claim",
    targetId: claim.id,
    metadata: { title: claim.title, amount: claim.amount.toString() },
  });
}

// --- Audit log -------------------------------------------------------------------

export function listAuditLog() {
  return adminRepo.findRecentAuditLogEntries();
}

// --- Approval requests (card/budget maker-checker) --------------------------------

export interface ListApprovalRequestsParams {
  status?: string;
  targetType?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

// ApprovalRequest has no Prisma relations (company/requester are plain id
// columns, joined manually below), so text search and pagination happen in
// JS rather than in the query — fine at this table's scale.
export async function listApprovalRequests({ status, targetType, q, page, pageSize }: ListApprovalRequestsParams) {
  const requests = await adminRepo.findApprovalRequests({
    ...(status ? { status: status as "PENDING" | "APPROVED" | "REJECTED" } : {}),
    ...(targetType ? { targetType: targetType as "CARD" | "BUDGET" } : {}),
  });

  const userIds = Array.from(new Set(requests.flatMap((r) => [r.requesterId, r.reviewerId]).filter((id): id is string => !!id)));
  const users = await adminRepo.findUsersByIds(userIds);
  const userMap = new Map(users.map((u) => [u.id, u]));

  const companyIds = Array.from(new Set(requests.map((r) => r.companyId)));
  const companies = await adminRepo.findCompaniesByIds(companyIds);
  const companyMap = new Map(companies.map((c) => [c.id, c]));

  const enriched = requests.map((r) => ({
    id: r.id,
    targetType: r.targetType,
    targetId: r.targetId,
    status: r.status,
    reason: r.reason,
    metadata: r.metadata ? JSON.parse(r.metadata) : {},
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt,
    company: companyMap.get(r.companyId) ?? null,
    requester: userMap.get(r.requesterId) ?? null,
    reviewer: r.reviewerId ? userMap.get(r.reviewerId) ?? null : null,
  }));

  const needle = q?.trim().toLowerCase() ?? "";
  const filtered = needle
    ? enriched.filter((r) => {
        const meta = Object.values(r.metadata).filter(Boolean).join(" ");
        return [meta, r.company?.name, r.requester?.name, r.requester?.email]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
    : enriched;

  const total = filtered.length;
  const paged = page && pageSize ? filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize) : filtered;

  return { requests: paged, total };
}

async function updateApprovalTarget(
  targetType: "CARD" | "BUDGET",
  targetId: string,
  action: "ACTIVATE" | { rejectionReason: string }
) {
  if (targetType === "CARD") {
    return action === "ACTIVATE" ? adminRepo.activateCard(targetId) : adminRepo.rejectCard(targetId, action.rejectionReason);
  }
  return action === "ACTIVATE" ? adminRepo.activateBudget(targetId) : adminRepo.rejectBudget(targetId, action.rejectionReason);
}

export async function approveApprovalRequest(id: string, actorUserId: string) {
  const request = await adminRepo.findApprovalRequestById(id);
  if (!request) {
    throw new NotFoundError("Request not found");
  }
  if (request.status !== "PENDING") {
    throw new UnprocessableEntityError("This request has already been reviewed");
  }

  await adminRepo.approveApprovalRequestRecord(request.id, actorUserId);
  await updateApprovalTarget(request.targetType, request.targetId, "ACTIVATE");

  await writeAuditLog({
    action: `${request.targetType}_APPROVED`,
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: request.targetType === "CARD" ? "Card" : "Budget",
    targetId: request.targetId,
  });
}

export async function rejectApprovalRequest(id: string, reason: string, actorUserId: string) {
  const request = await adminRepo.findApprovalRequestById(id);
  if (!request) {
    throw new NotFoundError("Request not found");
  }
  if (request.status !== "PENDING") {
    throw new UnprocessableEntityError("This request has already been reviewed");
  }

  await adminRepo.rejectApprovalRequestRecord(request.id, actorUserId, reason);
  await updateApprovalTarget(request.targetType, request.targetId, { rejectionReason: reason });

  await writeAuditLog({
    action: `${request.targetType}_REJECTED`,
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: request.targetType === "CARD" ? "Card" : "Budget",
    targetId: request.targetId,
    metadata: { reason },
  });
}

export async function deleteApprovalRequest(id: string, actorUserId: string) {
  const request = await adminRepo.findApprovalRequestById(id);
  if (!request) {
    throw new NotFoundError("Request not found");
  }

  await adminRepo.deleteApprovalRequestRecord(request.id);
  if (request.targetType === "CARD") {
    await adminRepo.deleteCardByApprovalTarget(request.targetId);
  } else {
    await adminRepo.deleteBudgetByApprovalTarget(request.targetId);
  }

  await writeAuditLog({
    action: `${request.targetType}_REQUEST_DELETED`,
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: request.targetType === "CARD" ? "Card" : "Budget",
    targetId: request.targetId,
  });
}

// --- KYB review ------------------------------------------------------------------

export function listKybCompanies(status?: string) {
  return adminRepo.findKybCompanies({
    users: { none: { isStaff: true } },
    ...(status
      ? { kybStatus: status as "NOT_STARTED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "NEEDS_INFO" }
      : {}),
  });
}

export async function getKybCompanyDetail(companyId: string) {
  const company = await adminRepo.findKybCompanyDetail(companyId);
  if (!company) {
    throw new NotFoundError("Company not found");
  }
  return company;
}

async function requirePendingKybCompany(companyId: string) {
  const company = await adminRepo.findCompanyById(companyId);
  if (!company) {
    throw new NotFoundError("Company not found");
  }
  if (company.kybStatus !== "PENDING_REVIEW") {
    throw new UnprocessableEntityError("This company isn't awaiting review");
  }
  return company;
}

export async function approveKyb(companyId: string, actorUserId: string) {
  const company = await requirePendingKybCompany(companyId);
  await adminRepo.updateCompanyKybDecision(company.id, { kybStatus: "APPROVED", kybRejectionReason: null });

  await writeAuditLog({
    action: "KYB_APPROVED",
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: "Company",
    targetId: company.id,
  });
}

export async function rejectKyb(companyId: string, reason: string, actorUserId: string) {
  const company = await requirePendingKybCompany(companyId);
  await adminRepo.updateCompanyKybDecision(company.id, { kybStatus: "REJECTED", kybRejectionReason: reason });

  await writeAuditLog({
    action: "KYB_REJECTED",
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: "Company",
    targetId: company.id,
    metadata: { reason },
  });
}

export async function kybNeedsInfo(companyId: string, reason: string, actorUserId: string) {
  const company = await requirePendingKybCompany(companyId);
  await adminRepo.updateCompanyKybDecision(company.id, { kybStatus: "NEEDS_INFO", kybRejectionReason: reason });

  await writeAuditLog({
    action: "KYB_NEEDS_INFO",
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: "Company",
    targetId: company.id,
    metadata: { reason },
  });
}

// ---------------------------------------------------------------------------
// Credit Apply (maker-checker) — Operation dashboard controls the lending
// side of a company's account. One staff member (maker) submits a request,
// a *different* staff member (checker) approves or rejects it.
// ---------------------------------------------------------------------------

export async function listCreditApplies(status?: string) {
  const applies = await adminRepo.findCreditApplies(
    status ? { status: status as "PENDING_MAKER" | "PENDING_CHECKER" | "APPROVED" | "REJECTED" } : undefined
  );

  const companyIds = Array.from(new Set(applies.map((a) => a.companyId)));
  const companies = await adminRepo.findCompaniesByIds(companyIds);
  const companyMap = new Map(companies.map((c) => [c.id, c]));

  const userIds = Array.from(
    new Set(applies.flatMap((a) => [a.makerId, a.checkerId, a.submittedById]).filter((id): id is string => !!id))
  );
  const users = await adminRepo.findUsersByIds(userIds);
  const userMap = new Map(users.map((u) => [u.id, u]));

  return applies.map((a) => ({
    ...a,
    company: companyMap.get(a.companyId) ?? null,
    maker: a.makerId ? userMap.get(a.makerId) ?? null : null,
    checker: a.checkerId ? userMap.get(a.checkerId) ?? null : null,
    submittedBy: a.submittedById ? userMap.get(a.submittedById) ?? null : null,
  }));
}

// Decision-support snapshot shown to staff while reviewing a Credit Apply —
// built from data already in the system (cash flow, overdue bills), not a
// real bureau pull. See getCreditRiskSnapshot for the heuristics used.
export async function getCreditApplyRiskSnapshot(id: string) {
  const creditApply = await adminRepo.findCreditApplyById(id);
  if (!creditApply) {
    throw new NotFoundError("Credit Apply not found");
  }
  return getCreditRiskSnapshot(creditApply.companyId, Number(creditApply.requestedAmount));
}

export interface CreateCreditApplyParams {
  companyId: string;
  requestedAmount: number;
  note?: string;
}

export async function createCreditApply({ companyId, requestedAmount, note }: CreateCreditApplyParams, actorUserId: string) {
  if (requestedAmount < MIN_CREDIT_APPLY_AMOUNT) {
    throw new UnprocessableEntityError(`Minimum credit apply amount is $${MIN_CREDIT_APPLY_AMOUNT.toLocaleString()}.`);
  }

  const company = await adminRepo.findCompanyById(companyId);
  if (!company) {
    throw new NotFoundError("Company not found");
  }
  if (company.kybStatus !== "APPROVED") {
    throw new UnprocessableEntityError("This company's KYB must be approved before a Credit Apply can be created.");
  }
  if (!company.contractAcceptedAt) {
    throw new UnprocessableEntityError("This company hasn't signed the lending contract yet.");
  }

  const existing = await getActiveCreditApply(companyId);
  if (existing) {
    throw new UnprocessableEntityError("This company already has a pending or approved Credit Apply.");
  }

  const creditApply = await adminRepo.createCreditApplyRecord({
    companyId,
    requestedAmount,
    makerNote: note,
    makerId: actorUserId,
  });

  await writeAuditLog({
    action: "CREDIT_APPLY_CREATED",
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: "CreditApply",
    targetId: creditApply.id,
    metadata: { companyId, requestedAmount: requestedAmount.toString() },
  });

  return creditApply;
}

// The "maker" step for a customer-submitted application: a staff member
// reviews it (ideally after checking the risk snapshot) and forwards it into
// the checker queue. Any staff member may forward — the maker/checker split
// only needs to be enforced once it reaches approve/reject, same as before.
export async function forwardCreditApply(id: string, note: string | undefined, actorUserId: string) {
  const creditApply = await adminRepo.findCreditApplyById(id);
  if (!creditApply) {
    throw new NotFoundError("Credit Apply not found");
  }
  if (creditApply.status !== "PENDING_MAKER") {
    throw new UnprocessableEntityError("This request isn't awaiting maker review.");
  }

  const updated = await adminRepo.forwardCreditApplyRecord(creditApply.id, actorUserId, note);

  await writeAuditLog({
    action: "CREDIT_APPLY_FORWARDED",
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: "CreditApply",
    targetId: creditApply.id,
  });

  return updated;
}

export interface ApproveCreditApplyParams {
  approvedAmount?: number;
  interestRatePct?: number;
  termMonths?: number;
  note?: string;
}

export async function approveCreditApply(id: string, params: ApproveCreditApplyParams, actorUserId: string) {
  const creditApply = await adminRepo.findCreditApplyById(id);
  if (!creditApply) {
    throw new NotFoundError("Credit Apply not found");
  }
  if (creditApply.status !== "PENDING_CHECKER") {
    throw new UnprocessableEntityError("This request has already been reviewed");
  }
  if (creditApply.makerId === actorUserId) {
    throw new ForbiddenError("The checker must be a different staff member than the maker.");
  }

  const approvedAmount = params.approvedAmount ?? Number(creditApply.requestedAmount);
  const offeredInterestRatePct = params.interestRatePct ?? DEFAULT_INTEREST_RATE_PCT;
  const offeredTermMonths = params.termMonths ?? DEFAULT_TERM_MONTHS;

  const updated = await adminRepo.approveCreditApplyRecord(creditApply.id, {
    approvedAmount,
    offeredInterestRatePct,
    offeredTermMonths,
    checkerId: actorUserId,
    checkerNote: params.note,
  });

  await writeAuditLog({
    action: "CREDIT_APPLY_APPROVED",
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: "CreditApply",
    targetId: creditApply.id,
    metadata: { approvedAmount: approvedAmount.toString(), offeredInterestRatePct, offeredTermMonths },
  });

  return updated;
}

export async function rejectCreditApply(id: string, reason: string, actorUserId: string) {
  const creditApply = await adminRepo.findCreditApplyById(id);
  if (!creditApply) {
    throw new NotFoundError("Credit Apply not found");
  }
  if (creditApply.status !== "PENDING_MAKER" && creditApply.status !== "PENDING_CHECKER") {
    throw new UnprocessableEntityError("This request has already been reviewed");
  }
  if (creditApply.status === "PENDING_CHECKER" && creditApply.makerId === actorUserId) {
    throw new ForbiddenError("The checker must be a different staff member than the maker.");
  }

  const updated = await adminRepo.rejectCreditApplyRecord(creditApply.id, actorUserId, reason);

  await writeAuditLog({
    action: "CREDIT_APPLY_REJECTED",
    actorEmail: await resolveActorEmail(actorUserId),
    targetType: "CreditApply",
    targetId: creditApply.id,
    metadata: { reason },
  });

  return updated;
}
