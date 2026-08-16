import { prisma } from "../../lib/prisma";

export function createApprovalRequestRecord(input: {
  targetType: "CARD" | "BUDGET";
  targetId: string;
  companyId: string;
  requesterId: string;
  metadata: string;
}) {
  return prisma.approvalRequest.create({
    data: {
      targetType: input.targetType,
      targetId: input.targetId,
      companyId: input.companyId,
      requesterId: input.requesterId,
      metadata: input.metadata,
    },
  });
}
