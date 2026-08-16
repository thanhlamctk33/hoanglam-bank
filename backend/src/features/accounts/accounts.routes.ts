import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { NotFoundError, LockedError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { FX_CURRENCIES } from "../../shared/fx/fx.service";
import { accrueInterest } from "./interest.service";
import { generateUniqueAccountNumber } from "./accounts.service";
import { MAX_OVERDRAFT_LIMIT } from "../../shared/overdraft/overdraft.config";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await accrueInterest(req.companyId!);
    const accounts = await prisma.account.findMany({
      where: { companyId: req.companyId },
      orderBy: { createdAt: "asc" },
    });
    res.json({ accounts });
  })
);

const createAccountSchema = z.object({
  name: z.string().min(1).max(60),
  currency: z.enum(FX_CURRENCIES),
  type: z.enum(["CHECKING", "SAVINGS", "MONEY_MARKET"]).default("CHECKING"),
});

// Companies start with one USD account (created at registration). This lets
// them open additional ones — e.g. a second USD account for a different
// purpose, or an account in another currency — with a zero starting
// balance; fund it afterwards via "Add funds" or a transfer.
router.post(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const accountNumber = await generateUniqueAccountNumber();
    const account = await prisma.account.create({
      data: {
        name: parsed.data.name.trim(),
        type: parsed.data.type,
        currency: parsed.data.currency,
        accountNumber,
        balance: 0,
        companyId: req.companyId!,
      },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "ACCOUNT_OPENED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Account",
      targetId: account.id,
      metadata: { name: account.name, type: account.type, currency: account.currency },
    });

    res.status(201).json({ account });
  })
);

const depositSchema = z.object({
  amount: z.number().positive().max(1_000_000),
});

// Sandbox-only: simulates an incoming wire so new companies (and anyone
// testing the app) have a way to fund an account without a real bank rail.
router.post(
  "/:id/deposit",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = depositSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const account = await prisma.account.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!account) {
      throw new NotFoundError("Account not found");
    }
    if (account.frozen) {
      throw new LockedError("This account is frozen.");
    }

    const { amount } = parsed.data;

    const [updated] = await prisma.$transaction([
      prisma.account.update({ where: { id: account.id }, data: { balance: { increment: amount } } }),
      prisma.transaction.create({
        data: {
          accountId: account.id,
          amount,
          currency: account.currency,
          type: "CREDIT",
          description: "Wire-in deposit (sandbox)",
          category: "Deposit",
        },
      }),
    ]);

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "SANDBOX_DEPOSIT_COMPLETED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Account",
      targetId: account.id,
      metadata: { amount: amount.toString() },
    });

    res.json({ account: updated });
  })
);

const overdraftSchema = z.object({
  overdraftLimit: z.number().min(0).max(MAX_OVERDRAFT_LIMIT),
});

// Sets how far this account may go negative before a debit is rejected.
// Only an account Admin can change it — same trust level as freezing an
// account or opening a new one.
router.patch(
  "/:id/overdraft",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = overdraftSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const account = await prisma.account.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!account) {
      throw new NotFoundError("Account not found");
    }

    const updated = await prisma.account.update({
      where: { id: account.id },
      data: { overdraftLimit: parsed.data.overdraftLimit },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "OVERDRAFT_LIMIT_UPDATED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Account",
      targetId: account.id,
      metadata: { overdraftLimit: parsed.data.overdraftLimit.toString() },
    });

    res.json({ account: updated });
  })
);

// Monthly statement: reconstructs the opening/closing balance for the
// requested month from the account's CURRENT balance by working backwards —
// there's no per-transaction running-balance column stored, so opening
// balance = current balance, minus the net effect of every transaction
// dated after the statement month, minus the net effect of the month
// itself (equivalently: closing balance = current balance minus net-after,
// opening balance = closing balance minus net-within-month).
router.get(
  "/:id/statement",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const account = await prisma.account.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!account) {
      throw new NotFoundError("Account not found");
    }

    const monthParam = parseQueryString(req.query.month); // "YYYY-MM"
    const now = new Date();
    const [y, m] = monthParam && /^\d{4}-\d{2}$/.test(monthParam)
      ? monthParam.split("-").map(Number)
      : [now.getFullYear(), now.getMonth() + 1];
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 1);

    const [transactions, afterCredit, afterDebit, inMonthCredit, inMonthDebit] = await Promise.all([
      prisma.transaction.findMany({
        where: { accountId: account.id, date: { gte: monthStart, lt: monthEnd } },
        orderBy: { date: "asc" },
      }),
      prisma.transaction.aggregate({
        where: { accountId: account.id, type: "CREDIT", date: { gte: monthEnd } },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { accountId: account.id, type: "DEBIT", date: { gte: monthEnd } },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { accountId: account.id, type: "CREDIT", date: { gte: monthStart, lt: monthEnd } },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { accountId: account.id, type: "DEBIT", date: { gte: monthStart, lt: monthEnd } },
        _sum: { amount: true },
      }),
    ]);

    const netAfter = Number(afterCredit._sum.amount ?? 0) - Number(afterDebit._sum.amount ?? 0);
    const totalIn = Number(inMonthCredit._sum.amount ?? 0);
    const totalOut = Number(inMonthDebit._sum.amount ?? 0);
    const closingBalance = Number(account.balance) - netAfter;
    const openingBalance = closingBalance - (totalIn - totalOut);

    res.json({
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
    });
  })
);

// Testing/demo convenience: wipes every transaction for the company's
// accounts and zeroes out each balance, mirroring the "Reset ... demo data"
// buttons on Credit and Interbank Lending. Lets a tester get back to a
// clean slate without re-registering.
router.post(
  "/reset-demo",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const companyId = req.companyId!;

    const accounts = await prisma.account.findMany({ where: { companyId }, select: { id: true } });
    const accountIds = accounts.map((a) => a.id);

    await prisma.transaction.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.account.updateMany({ where: { companyId }, data: { balance: 0 } });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "ACCOUNTS_DEMO_RESET",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Company",
      targetId: companyId,
    });

    res.json({ ok: true });
  })
);

function parseQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

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

const demoDataSchema = z.object({
  months: z.number().int().min(1).max(24).default(6),
});

// Sandbox-only: fills an account with realistic randomized transactions
// spread over the requested window, so a freshly opened account (which
// otherwise shows empty everywhere — Transactions, Reports, Statements)
// has something to demo/test against without touching a terminal. Mirrors
// the shape of prisma/seed.ts's merchant list but is callable per-account
// from the UI instead of only at DB-seed time.
router.post(
  "/:id/generate-demo-data",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = demoDataSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const account = await prisma.account.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!account) {
      throw new NotFoundError("Account not found");
    }

    const { months } = parsed.data;
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

    await prisma.$transaction([
      prisma.transaction.createMany({ data: transactions }),
      prisma.account.update({ where: { id: account.id }, data: { balance: { increment: netEffect } } }),
    ]);

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "DEMO_DATA_GENERATED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Account",
      targetId: account.id,
      metadata: { count: transactions.length, months },
    });

    res.json({ created: transactions.length });
  })
);

router.get(
  "/reports",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
    const accountIdParam = parseQueryString(req.query.accountId);

    const accounts = await prisma.account.findMany({
      where: { companyId: req.companyId, ...(accountIdParam ? { id: accountIdParam } : {}) },
      select: { id: true },
    });
    if (accountIdParam && accounts.length === 0) {
      throw new NotFoundError("Account not found");
    }
    const accountIds = accounts.map((a) => a.id);

    const now = new Date();
    const rangeStart = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

    const transactions = accountIds.length
      ? await prisma.transaction.findMany({
          where: { accountId: { in: accountIds }, date: { gte: rangeStart } },
          select: { amount: true, type: true, category: true, date: true },
        })
      : [];

    const monthKeys: string[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    const seriesMap = new Map<string, { month: string; in: number; out: number }>(
      monthKeys.map((k) => [k, { month: k, in: 0, out: 0 }])
    );
    const categoryMap = new Map<string, number>();

    for (const t of transactions) {
      const d = new Date(t.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const amt = Number(t.amount);
      const bucket = seriesMap.get(key);
      if (bucket) {
        if (t.type === "CREDIT") bucket.in += amt;
        else bucket.out += amt;
      }
      if (t.type === "DEBIT") {
        const cat = t.category || "Other";
        categoryMap.set(cat, (categoryMap.get(cat) ?? 0) + amt);
      }
    }

    const series = Array.from(seriesMap.values());
    const categories = Array.from(categoryMap.entries())
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);

    const totalIn = series.reduce((sum, m) => sum + m.in, 0);
    const totalOut = series.reduce((sum, m) => sum + m.out, 0);

    res.json({ series, categories, totalIn, totalOut, accountCount: accountIds.length });
  })
);

router.get(
  "/:id/transactions",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const account = await prisma.account.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
    });
    if (!account) {
      throw new NotFoundError("Account not found");
    }

    const take = Math.min(Math.max(Number(req.query.take) || 25, 1), 200);
    const skip = Math.max(Number(req.query.skip) || 0, 0);

    const typeParam = req.query.type;
    const type = typeParam === "DEBIT" || typeParam === "CREDIT" ? typeParam : undefined;
    const category = parseQueryString(req.query.category);
    const fromStr = parseQueryString(req.query.from);
    const toStr = parseQueryString(req.query.to);
    const from = fromStr ? new Date(fromStr) : undefined;
    const to = toStr ? new Date(toStr) : undefined;

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
      prisma.transaction.findMany({ where, orderBy: { date: "desc" }, skip, take }),
      prisma.transaction.count({ where }),
      prisma.transaction.aggregate({ where: { ...baseWhere, type: "CREDIT" }, _sum: { amount: true } }),
      prisma.transaction.aggregate({ where: { ...baseWhere, type: "DEBIT" }, _sum: { amount: true } }),
    ]);

    res.json({
      transactions,
      total,
      hasMore: skip + transactions.length < total,
      sumIn: aggIn._sum.amount ?? 0,
      sumOut: aggOut._sum.amount ?? 0,
    });
  })
);

router.get(
  "/:id/transaction-categories",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const account = await prisma.account.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
    });
    if (!account) {
      throw new NotFoundError("Account not found");
    }

    const rows = await prisma.transaction.findMany({
      where: { accountId: account.id, category: { not: null } },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
    });
    res.json({ categories: rows.map((r) => r.category as string) });
  })
);

export default router;
