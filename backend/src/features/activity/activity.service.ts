import * as activityRepo from "./activity.repository";

/**
 * A company-scoped view over the shared AuditLog table. AuditLog has no
 * companyId column (it's also used for bank-staff cross-company actions), so
 * this filters by actorEmail belonging to one of the company's own users —
 * email is globally unique, so that's an exact, safe scope. No new table.
 */

export async function listActivity(companyId: string, take: number) {
  const members = await activityRepo.findCompanyMembers(companyId);
  const emails = members.map((m) => m.email);
  if (emails.length === 0) {
    return [];
  }
  const nameByEmail = new Map(members.map((m) => [m.email, m.name]));

  const rows = await activityRepo.findAuditLogsByActors(emails, take);

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actorEmail: r.actorEmail,
    actorName: nameByEmail.get(r.actorEmail) ?? r.actorEmail,
    targetType: r.targetType,
    targetId: r.targetId,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    createdAt: r.createdAt,
  }));
}
