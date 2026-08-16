import { prisma } from "../../lib/prisma";
import { ANOMALY_LOOKBACK_COUNT } from "./fraud.config";

/** All direct Prisma access for fraud checks lives here — fraud.service.ts never touches `prisma` itself. */
export function findSpendPolicy(companyId: string) {
  return prisma.spendPolicy.findUnique({ where: { companyId } });
}

export function countRecentDebits(accountId: string, since: Date) {
  return prisma.transaction.count({
    where: { accountId, type: "DEBIT", date: { gte: since } },
  });
}

export function findRecentDebits(accountId: string, excludeTransactionId: string) {
  return prisma.transaction.findMany({
    where: { accountId, type: "DEBIT", id: { not: excludeTransactionId } },
    orderBy: { date: "desc" },
    take: ANOMALY_LOOKBACK_COUNT,
    select: { amount: true },
  });
}

export function flagTransaction(transactionId: string, flagReason: string) {
  return prisma.transaction.update({
    where: { id: transactionId },
    data: { flagged: true, flagReason },
  });
}
