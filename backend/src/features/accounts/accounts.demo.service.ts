import { writeAuditLog, resolveActorEmail } from "../../shared/audit/audit.service";
import * as accountsRepo from "./accounts.repository";
import { requireOwnAccount } from "./accounts.service";

/**
 * Sandbox-only helpers, kept out of accounts.service.ts so demo data
 * generation is never mistaken for real money movement. Both entry points
 * are mounted behind an `isProduction` guard — see accounts.demo.routes.ts.
 */

function randomAmount(min: number, max: number) {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

const DEMO_MERCHANTS: { desc: string; category: string; type: "DEBIT" | "CREDIT" }[] = [
  { desc: "AWS Cloud Services", category: "Software", type: "DEBIT" },
  { desc: "Client Payment - Acme Corp", category: "Revenue", type: "CREDIT" },
  { desc: "Google Workspace", category: "Software", type: "DEBIT" },
  { desc: "Office Rent", category: "Facilities", type: "DEBIT" },
  { desc: "Client Payment - Globex", category: "Revenue", type: "CREDIT" },
  { desc: "Payroll Run", category: "Payroll", type: "DEBIT" },
  { desc: "Facebook Ads", category: "Marketing", type: "DEBIT" },
  { desc: "Client Payment - Initech", category: "Revenue", type: "CREDIT" },
  { desc: "Office Supplies", category: "Office supplies", type: "DEBIT" },
  { desc: "Zoom Subscription", category: "Software", type: "DEBIT" },
  { desc: "Client Payment - Umbrella Corp", category: "Revenue", type: "CREDIT" },
  { desc: "Business Travel", category: "Travel", type: "DEBIT" },
];

/**
 * Fills an account with realistic randomized transactions spread over the
 * requested window, so a freshly opened account (which otherwise shows empty
 * everywhere — Transactions, Reports, Statements) has something to
 * demo/test against without touching a terminal. Mirrors the shape of
 * prisma/seed.ts's merchant list but is callable per-account from the UI
 * instead of only at DB-seed time.
 */
export async function generateDemoData(companyId: string, accountId: string, months: number, userId: string) {
  const account = await requireOwnAccount(companyId, accountId);

  const rangeMs = months * 30 * 24 * 60 * 60 * 1000;
  const count = Math.max(8, months * 4);
  const now = Date.now();

  const transactions = Array.from({ length: count }).map(() => {
    const merchant = DEMO_MERCHANTS[Math.floor(Math.random() * DEMO_MERCHANTS.length)];
    const amount = merchant.type === "DEBIT" ? randomAmount(50, 5000) : randomAmount(1000, 20000);
    return {
      accountId: account.id,
      amount,
      currency: account.currency,
      type: merchant.type,
      description: merchant.desc,
      category: merchant.category,
      merchant: merchant.desc,
      date: new Date(now - Math.random() * rangeMs),
    };
  });

  const netEffect = transactions.reduce((sum, t) => sum + (t.type === "CREDIT" ? t.amount : -t.amount), 0);

  await accountsRepo.runBatch([
    accountsRepo.createTransactions(transactions),
    accountsRepo.applyNetEffect(account.id, netEffect),
  ]);

  await writeAuditLog({
    action: "DEMO_DATA_GENERATED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Account",
    targetId: account.id,
    metadata: { count: transactions.length, months },
  });

  return transactions.length;
}

/**
 * Wipes every transaction for the company's accounts and zeroes out each
 * balance, mirroring the "Reset ... demo data" buttons on Credit and
 * Interbank Lending. Lets a tester get back to a clean slate without
 * re-registering.
 */
export async function resetDemoData(companyId: string, userId: string) {
  const accounts = await accountsRepo.findAccountIdsByCompany(companyId);
  const accountIds = accounts.map((a) => a.id);

  await accountsRepo.deleteTransactionsForAccounts(accountIds);
  await accountsRepo.zeroBalances(companyId);

  await writeAuditLog({
    action: "ACCOUNTS_DEMO_RESET",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Company",
    targetId: companyId,
  });
}
