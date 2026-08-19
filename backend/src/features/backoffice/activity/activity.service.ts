import * as activityRepo from "./activity.repository";

/**
 * A company-scoped view over the shared AuditLog table. AuditLog has no
 * companyId column (it's also used for bank-staff cross-company actions), so
 * this filters by actorEmail belonging to one of the company's own users —
 * email is globally unique, so that's an exact, safe scope. No new table.
 */

export async function listActivity(companyId: string, take: number) {
  const members = await activityRepo.findCompanyMembers(companyId);
  const emails = members.map((member) => member.email);
  if (emails.length === 0) {
    return [];
  }
  const nameByEmail = new Map(members.map((member) => [member.email, member.name]));

  const auditLogs = await activityRepo.findAuditLogsByActors(emails, take);

  return auditLogs.map((auditLog) => ({
    id: auditLog.id,
    action: auditLog.action,
    actorEmail: auditLog.actorEmail,
    actorName: nameByEmail.get(auditLog.actorEmail) ?? auditLog.actorEmail,
    targetType: auditLog.targetType,
    targetId: auditLog.targetId,
    metadata: auditLog.metadata ? JSON.parse(auditLog.metadata) : null,
    createdAt: auditLog.createdAt,
  }));
}
