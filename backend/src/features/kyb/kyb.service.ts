import { KybStatus, UNVERIFIED_TRANSACTION_LIMIT } from "./kyb.config";
import { findCompanyKybStatus } from "./kyb.repository";

export async function getKybStatus(companyId: string): Promise<KybStatus> {
  const company = await findCompanyKybStatus(companyId);
  return (company?.kybStatus as KybStatus) ?? "NOT_STARTED";
}

/**
 * Checks whether a money-movement of `amount` is allowed for a company that
 * hasn't completed business verification yet. Approved companies have no cap.
 */
export async function checkTransactionAllowed(
  companyId: string,
  amount: number
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  if (amount <= UNVERIFIED_TRANSACTION_LIMIT) return { allowed: true };

  const status = await getKybStatus(companyId);
  if (status === "APPROVED") return { allowed: true };

  return {
    allowed: false,
    message: `Payments over $${UNVERIFIED_TRANSACTION_LIMIT.toLocaleString()} require completed business verification. Finish it under Settings → Business verification.`,
  };
}

export async function checkPhysicalCardAllowed(
  companyId: string
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const status = await getKybStatus(companyId);
  if (status === "APPROVED") return { allowed: true };
  return {
    allowed: false,
    message: "Physical cards require completed business verification. Finish it under Settings → Business verification.",
  };
}
