import { Prisma } from "@prisma/client";
import { LockedError, NotFoundError } from "../../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../../shared/audit/audit.service";
import { accrueInterest } from "../interest/interest.service";
import * as accountsRepo from "./accounts.repository";

/**
 * Business logic for cash accounts — every route in accounts.routes.ts is a
 * thin validate-then-call-this wrapper. All Prisma access goes through
 * accounts.repository.ts. Sandbox-only endpoints live in
 * accounts.demo.service.ts instead, so demo data generation can't be
 * confused with real money movement.
 */

export async function generateUniqueAccountNumber(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `US-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;
    const existing = await accountsRepo.findAccountByNumber(candidate);
    if (!existing) return candidate;
  }
  throw new Error("Could not generate a unique account number");
}

/** Loads a company's own account, or throws 404. */
export async function requireOwnAccount(companyId: string, accountId: string) {
  const account = await accountsRepo.findOwnAccount(companyId, accountId);
  if (!account) {
    throw new NotFoundError("Account not found");
  }
  return account;
}

export async function listAccounts(companyId: string) {
  await accrueInterest(companyId);
  return accountsRepo.findAccountsByCompany(companyId);
}

export interface CreateAccountParams {
  name: string;
  currency: string;
  type: "CHECKING" | "SAVINGS" | "MONEY_MARKET";
}

// Companies start with one USD account (created at registration). This lets
// them open additional ones — e.g. a second USD account for a different
// purpose, or an account in another currency — with a zero starting
// balance; fund it afterwards via "Add funds" or a transfer.
export async function createAccount(companyId: string, userId: string, params: CreateAccountParams) {
  const accountNumber = await generateUniqueAccountNumber();
  const account = await accountsRepo.createAccount({
    name: params.name.trim(),
    type: params.type,
    currency: params.currency,
    accountNumber,
    balance: 0,
    companyId,
  });

  await writeAuditLog({
    action: "ACCOUNT_OPENED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Account",
    targetId: account.id,
    metadata: { name: account.name, type: account.type, currency: account.currency },
  });

  return account;
}

// Sandbox-only: simulates an incoming wire so new companies (and anyone
// testing the app) have a way to fund an account without a real bank rail.
export async function depositFunds(companyId: string, accountId: string, amount: number, userId: string) {
  const account = await requireOwnAccount(companyId, accountId);
  if (account.frozen) {
    throw new LockedError("This account is frozen.");
  }

  const [updated] = await accountsRepo.creditAccount(
    account.id,
    amount,
    account.currency,
    "Wire-in deposit (sandbox)",
    "Deposit"
  );

  await writeAuditLog({
    action: "SANDBOX_DEPOSIT_COMPLETED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Account",
    targetId: account.id,
    metadata: { amount: amount.toString() },
  });

  return updated;
}

// Sets how far this account may go negative before a debit is rejected.
// Only an account Admin can change it — same trust level as freezing an
// account or opening a new one.
export async function setOverdraftLimit(companyId: string, accountId: string, overdraftLimit: number, userId: string) {
  const account = await requireOwnAccount(companyId, accountId);
  const updated = await accountsRepo.updateOverdraftLimit(account.id, overdraftLimit);

  await writeAuditLog({
    action: "OVERDRAFT_LIMIT_UPDATED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Account",
    targetId: account.id,
    metadata: { overdraftLimit: overdraftLimit.toString() },
  });

  return updated;
}

// Monthly statement: reconstructs the opening/closing balance for the
// requested month from the account's CURRENT balance by working backwards —
// there's no per-transaction running-balance column stored, so opening
// balance = current balance, minus the net effect of every transaction
// dated after the statement month, minus the net effect of the month
// itself (equivalently: closing balance = current balance minus net-after,
// opening balance = closing balance minus net-within-month).
export async function getStatement(companyId: string, accountId: string, monthParam?: string) {
  const account = await requireOwnAccount(companyId, accountId);

  const now = new Date();
  const [y, m] =
    monthParam && /^\d{4}-\d{2}$/.test(monthParam)
      ? monthParam.split("-").map(Number)
      : [now.getFullYear(), now.getMonth() + 1];
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 1);

  const [transactions, afterCredit, afterDebit, inMonthCredit, inMonthDebit] = await Promise.all([
    accountsRepo.findTransactionsInRange(account.id, monthStart, monthEnd),
    accountsRepo.sumTransactions({ accountId: account.id, type: "CREDIT", date: { gte: monthEnd } }),
    accountsRepo.sumTransactions({ accountId: account.id, type: "DEBIT", date: { gte: monthEnd } }),
    accountsRepo.sumTransactions({ accountId: account.id, type: "CREDIT", date: { gte: monthStart, lt: monthEnd } }),
    accountsRepo.sumTransactions({ accountId: account.id, type: "DEBIT", date: { gte: monthStart, lt: monthEnd } }),
  ]);

  const netAfter = Number(afterCredit._sum.amount ?? 0) - Number(afterDebit._sum.amount ?? 0);
  const totalIn = Number(inMonthCredit._sum.amount ?? 0);
  const totalOut = Number(inMonthDebit._sum.amount ?? 0);
  const closingBalance = Number(account.balance) - netAfter;
  const openingBalance = closingBalance - (totalIn - totalOut);

  return {
    account: {
      id: account.id,
      name: account.name,
      accountNumber: account.accountNumber,
      currency: account.currency,
      type: account.type,
    },
    month: `${y}-${String(m).padStart(2, "0")}`,
    openingBalance,
    closingBalance,
    totalIn,
    totalOut,
    transactions,
  };
}

export async function getReports(companyId: string, months: number, accountId?: string) {
  const accounts = await accountsRepo.findAccountIdsByCompany(companyId, accountId);
  if (accountId && accounts.length === 0) {
    throw new NotFoundError("Account not found");
  }
  const accountIds = accounts.map((account) => account.id);

  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

  const transactions = accountIds.length ? await accountsRepo.findTransactionsForReport(accountIds, rangeStart) : [];

  const monthKeys: string[] = [];
  for (let monthsAgo = months - 1; monthsAgo >= 0; monthsAgo--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
    monthKeys.push(`${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`);
  }
  const seriesMap = new Map<string, { month: string; in: number; out: number }>(
    monthKeys.map((monthKey) => [monthKey, { month: monthKey, in: 0, out: 0 }])
  );
  const categoryMap = new Map<string, number>();

  for (const transaction of transactions) {
    const transactionDate = new Date(transaction.date);
    const monthKey = `${transactionDate.getFullYear()}-${String(transactionDate.getMonth() + 1).padStart(2, "0")}`;
    const amount = Number(transaction.amount);
    const monthBucket = seriesMap.get(monthKey);
    if (monthBucket) {
      if (transaction.type === "CREDIT") monthBucket.in += amount;
      else monthBucket.out += amount;
    }
    if (transaction.type === "DEBIT") {
      const categoryName = transaction.category || "Other";
      categoryMap.set(categoryName, (categoryMap.get(categoryName) ?? 0) + amount);
    }
  }

  const series = Array.from(seriesMap.values());
  const categories = Array.from(categoryMap.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((categoryA, categoryB) => categoryB.amount - categoryA.amount);

  const totalIn = series.reduce((sum, monthBucket) => sum + monthBucket.in, 0);
  const totalOut = series.reduce((sum, monthBucket) => sum + monthBucket.out, 0);

  return { series, categories, totalIn, totalOut, accountCount: accountIds.length };
}

export interface ListTransactionsParams {
  take: number;
  skip: number;
  type?: "DEBIT" | "CREDIT";
  category?: string;
  from?: string;
  to?: string;
}

export async function listTransactions(companyId: string, accountId: string, params: ListTransactionsParams) {
  const account = await requireOwnAccount(companyId, accountId);

  const { take, skip, type, category } = params;
  const from = params.from ? new Date(params.from) : undefined;
  const to = params.to ? new Date(params.to) : undefined;

  const baseWhere: Prisma.TransactionWhereInput = {
    accountId: account.id,
    ...(category ? { category } : {}),
    ...(from || to
      ? {
          date: {
            ...(from && !isNaN(from.getTime()) ? { gte: from } : {}),
            ...(to && !isNaN(to.getTime()) ? { lte: to } : {}),
          },
        }
      : {}),
  };
  const where: Prisma.TransactionWhereInput = { ...baseWhere, ...(type ? { type } : {}) };

  const [transactions, total, aggIn, aggOut] = await Promise.all([
    accountsRepo.findTransactions(where, skip, take),
    accountsRepo.countTransactions(where),
    accountsRepo.sumTransactions({ ...baseWhere, type: "CREDIT" }),
    accountsRepo.sumTransactions({ ...baseWhere, type: "DEBIT" }),
  ]);

  return {
    transactions,
    total,
    hasMore: skip + transactions.length < total,
    sumIn: aggIn._sum.amount ?? 0,
    sumOut: aggOut._sum.amount ?? 0,
  };
}

export async function listTransactionCategories(companyId: string, accountId: string) {
  const account = await requireOwnAccount(companyId, accountId);
  const categoryRows = await accountsRepo.findDistinctTransactionCategories(account.id);
  return categoryRows.map((categoryRow) => categoryRow.category as string);
}
