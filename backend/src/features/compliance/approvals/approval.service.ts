import { NotFoundError } from "../../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../../shared/audit/audit.service";
import * as approvalRepo from "./approval.repository";

/**
 * Business logic for the company-side approval queue — every route in
 * approvals.routes.ts is a thin validate-then-call-this wrapper. All Prisma
 * access goes through approval.repository.ts.
 *
 * This is the self-service counterpart to features/admin's cross-company
 * queue: company admins approve their own team's card/budget requests
 * without needing bank staff involvement.
 */

export async function createApprovalRequest(input: {
  targetType: "CARD" | "BUDGET";
  targetId: string;
  companyId: string;
  requesterId: string;
  metadata: Record<string, unknown>;
}) {
  await approvalRepo.createApprovalRequestRecord({
    targetType: input.targetType,
    targetId: input.targetId,
    companyId: input.companyId,
    requesterId: input.requesterId,
    metadata: JSON.stringify(input.metadata),
  });
}

export async function listPendingRequests(companyId: string, targetType?: string) {
  const requests = await approvalRepo.findPendingRequests(companyId, targetType as "CARD" | "BUDGET" | undefined);

  const requesterIds = Array.from(new Set(requests.map((request) => request.requesterId)));
  const requesters = await approvalRepo.findUsersByIds(requesterIds);
  const requesterMap = new Map(requesters.map((requester) => [requester.id, requester]));

  return requests.map((request) => ({
    id: request.id,
    targetType: request.targetType,
    targetId: request.targetId,
    reason: request.reason,
    metadata: request.metadata ? JSON.parse(request.metadata) : {},
    createdAt: request.createdAt,
    requester: requesterMap.get(request.requesterId) ?? null,
  }));
}

/** Loads a still-pending request belonging to this company, or throws 404. */
async function requirePendingRequest(companyId: string, id: string) {
  const request = await approvalRepo.findPendingRequestById(companyId, id);
  if (!request) {
    throw new NotFoundError("Request not found");
  }
  return request;
}

export async function approveRequest(companyId: string, id: string, userId: string) {
  const request = await requirePendingRequest(companyId, id);

  await approvalRepo.approveRequestRecord(request.id, userId);

  if (request.targetType === "CARD") {
    await approvalRepo.activateCard(request.targetId);
  } else {
    await approvalRepo.activateBudget(request.targetId);
  }

  await writeAuditLog({
    action: `${request.targetType}_APPROVED`,
    actorEmail: await resolveActorEmail(userId),
    targetType: request.targetType === "CARD" ? "Card" : "Budget",
    targetId: request.targetId,
  });
}

export async function rejectRequest(companyId: string, id: string, reason: string, userId: string) {
  const request = await requirePendingRequest(companyId, id);

  await approvalRepo.rejectRequestRecord(request.id, userId, reason);

  if (request.targetType === "CARD") {
    await approvalRepo.rejectCard(request.targetId, reason);
  } else {
    await approvalRepo.rejectBudget(request.targetId, reason);
  }

  await writeAuditLog({
    action: `${request.targetType}_REJECTED`,
    actorEmail: await resolveActorEmail(userId),
    targetType: request.targetType === "CARD" ? "Card" : "Budget",
    targetId: request.targetId,
    metadata: { reason },
  });
}
