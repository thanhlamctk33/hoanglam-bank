import { ConflictError, NotFoundError } from "../../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../../shared/audit/audit.service";
import * as payeesRepo from "./payees.repository";

/**
 * Saved payees — recipients a company names ahead of time, unlike "Recent
 * recipients" on the Transfer page which is derived after the fact from
 * transaction history. This is how a company labels a recipient before ever
 * sending them money.
 *
 * Every route in payees.routes.ts is a thin validate-then-call-this wrapper;
 * all Prisma access goes through payees.repository.ts.
 */

export function listPayees(companyId: string) {
  return payeesRepo.findPayees(companyId);
}

export interface CreatePayeeParams {
  nickname: string;
  accountNumber: string;
}

export async function createPayee(companyId: string, userId: string, params: CreatePayeeParams) {
  const accountNumber = params.accountNumber.trim();

  const existing = await payeesRepo.findPayeeByAccountNumber(companyId, params.accountNumber);
  if (existing) {
    throw new ConflictError("This account number is already saved");
  }

  const payee = await payeesRepo.createPayee({
    companyId,
    nickname: params.nickname.trim(),
    accountNumber,
  });

  await writeAuditLog({
    action: "PAYEE_SAVED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "SavedPayee",
    targetId: payee.id,
    metadata: { nickname: payee.nickname },
  });

  return payee;
}

export async function deletePayee(companyId: string, id: string) {
  const payee = await payeesRepo.findOwnPayee(companyId, id);
  if (!payee) {
    throw new NotFoundError("Saved payee not found");
  }
  await payeesRepo.deletePayee(payee.id);
}
