import { createApprovalRequestRecord } from "./approval.repository";

export async function createApprovalRequest(input: {
  targetType: "CARD" | "BUDGET";
  targetId: string;
  companyId: string;
  requesterId: string;
  metadata: Record<string, unknown>;
}) {
  await createApprovalRequestRecord({
    targetType: input.targetType,
    targetId: input.targetId,
    companyId: input.companyId,
    requesterId: input.requesterId,
    metadata: JSON.stringify(input.metadata),
  });
}
