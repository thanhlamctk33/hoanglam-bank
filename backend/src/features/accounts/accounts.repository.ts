import { prisma } from "../../lib/prisma";

export function findAccountByNumber(accountNumber: string) {
  return prisma.account.findUnique({ where: { accountNumber } });
}
