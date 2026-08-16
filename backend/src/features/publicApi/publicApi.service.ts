import { NotFoundError } from "../../errors/AppError";
import * as publicApiRepo from "./publicApi.repository";

/**
 * The public developer API's read model. Everything under /api/v1 is
 * authenticated with an ApiKey (x-api-key header) instead of the JWT the
 * rest of the app uses, and is scoped read-only to the key's own company.
 * Intentionally small: this is a demo of "what a real integration would
 * call," not a full mirror of the internal app API.
 */

export function listAccounts(companyId: string) {
  return publicApiRepo.findAccounts(companyId);
}

export async function listAccountTransactions(companyId: string, accountId: string, take: number) {
  const account = await publicApiRepo.findOwnAccount(companyId, accountId);
  if (!account) {
    throw new NotFoundError("Account not found");
  }
  return publicApiRepo.findTransactions(account.id, take);
}
