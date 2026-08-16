import { prisma } from "../../lib/prisma";

export function findInterestEligibleAccounts(companyId: string) {
  return prisma.account.findMany({
    where: { companyId, type: { in: ["SAVINGS", "MONEY_MARKET"] } },
  });
}

export function touchLastInterestAccrualAt(accountId: string, now: Date) {
  return prisma.account.update({ where: { id: accountId }, data: { lastInterestAccrualAt: now } });
}

export function postInterestAccrual(accountId: string, currency: string, interest: number, now: Date, description: string) {
  return prisma.$transaction([
    prisma.account.update({
      where: { id: accountId },
      data: { balance: { increment: interest }, lastInterestAccrualAt: now },
    }),
    prisma.transaction.create({
      data: {
        accountId,
        amount: interest,
        currency,
        type: "CREDIT",
        description,
        category: "Interest",
      },
    }),
  ]);
}
