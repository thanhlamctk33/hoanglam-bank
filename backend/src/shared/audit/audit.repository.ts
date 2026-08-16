import { prisma } from "../../lib/prisma";

export interface AuditLogInput {
  action: string;
  actorEmail: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** All direct Prisma access for audit logs lives here — audit.service.ts never touches `prisma` itself. */
export function createAuditLog(input: AuditLogInput) {
  return prisma.auditLog.create({
    data: {
      action: input.action,
      actorEmail: input.actorEmail,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
    },
  });
}
