import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

/** All direct Prisma access for repayments/installments lives here — repayment.service.ts never touches `prisma` itself. */
export function findDrawdownIdsByCompany(companyId: string) {
  return prisma.drawdown.findMany({ where: { companyId }, select: { id: true } });
}

export function findOverdueInstallments(drawdownIds: string[], now: Date) {
  return prisma.installment.findMany({
    where: {
      status: { in: ["PENDING", "PARTIAL"] },
      dueDate: { lt: now },
      drawdownId: { in: drawdownIds },
    },
  });
}

export function updateInstallment(id: string, data: Prisma.InstallmentUpdateInput) {
  return prisma.installment.update({ where: { id }, data });
}

export function findUnpaidInstallmentsByDrawdown(drawdownId: string) {
  return prisma.installment.findMany({ where: { drawdownId, status: { not: "PAID" } } });
}

export function findAutoDeductDrawdowns(companyId: string) {
  return prisma.drawdown.findMany({
    where: { companyId, autoDeduct: true, repaymentMethod: { not: "REVOLVING" } },
  });
}

export function findDueInstallments(drawdownId: string, now: Date) {
  return prisma.installment.findMany({
    where: {
      drawdownId,
      status: { in: ["PENDING", "PARTIAL", "OVERDUE"] },
      dueDate: { lte: now },
    },
  });
}

export function findAccountForAutoDeduct(accountId: string, companyId: string) {
  return prisma.account.findFirst({ where: { id: accountId, companyId } });
}

/** Thin passthrough to prisma.$transaction — lets repayment.service.ts run multi-step writes atomically without importing `prisma` itself. */
export function runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}
