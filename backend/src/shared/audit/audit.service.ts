import { AuditLogInput, createAuditLog } from "./audit.repository";

/** Used across nearly every feature to record an admin/staff action. */
export async function writeAuditLog(input: AuditLogInput) {
  await createAuditLog(input);
}
