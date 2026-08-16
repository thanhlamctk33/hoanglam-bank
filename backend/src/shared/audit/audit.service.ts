import { prisma } from "../../lib/prisma";
import { AuditLogInput, createAuditLog } from "./audit.repository";

/** Used across nearly every feature to record an admin/staff action. */
export async function writeAuditLog(input: AuditLogInput) {
  await createAuditLog(input);
}

/**
 * Looks up a user's email for the `actorEmail` field on an audit log entry.
 * Every feature that writes audit logs needs this, so it lives here instead
 * of being redefined per-route — falls back to "unknown" rather than
 * throwing, since a missing actor shouldn't block the audited action itself.
 */
export async function resolveActorEmail(userId: string | undefined): Promise<string> {
  if (!userId) return "unknown";
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user?.email ?? "unknown";
}
