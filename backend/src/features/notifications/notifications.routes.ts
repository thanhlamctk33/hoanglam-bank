import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { hasApprovalPower } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";

const router = Router();
router.use(requireAuth);

type Severity = "info" | "warning" | "urgent";

interface Notification {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  href: string;
  date: string;
}

function money(amount: number | string, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(
      Number(amount)
    );
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`;
  }
}

interface ApprovalMetadata {
  label?: string;
  name?: string;
  spendLimit?: string;
  amount?: string;
}

// Everything here is computed on the fly from existing tables (bills,
// budgets, approval requests, claims, credit) rather than a separate
// Notification table — same "derive, don't persist" approach used for
// recent transfer recipients. This is what powers the notification bell,
// consolidating alerts that used to be scattered across separate pages
// (KybBanner keeps handling the business-verification reminder on its own,
// since that's already a persistent top-of-page banner).
router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const companyId = req.companyId!;
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const canApprove = hasApprovalPower(user);

    const now = new Date();
    const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [bills, frozenBudgets, pendingApprovals, pendingClaims, approvedCredit] = await Promise.all([
      prisma.bill.findMany({
        where: { companyId, status: { in: ["UNPAID", "OVERDUE"] }, dueDate: { lte: soon } },
        orderBy: { dueDate: "asc" },
      }),
      prisma.budget.findMany({ where: { companyId, status: "FROZEN" } }),
      canApprove
        ? prisma.approvalRequest.findMany({ where: { companyId, status: "PENDING" }, orderBy: { createdAt: "desc" } })
        : Promise.resolve([]),
      canApprove
        ? prisma.claim.findMany({ where: { companyId, status: "PENDING" }, orderBy: { submittedAt: "desc" } })
        : Promise.resolve([]),
      prisma.creditApply.findFirst({
        where: { companyId, status: "APPROVED" },
        orderBy: { decidedAt: "desc" },
      }),
    ]);

    const notifications: Notification[] = [];

    for (const b of bills) {
      const overdue = b.status === "OVERDUE" || new Date(b.dueDate) < now;
      notifications.push({
        id: `bill:${b.id}`,
        severity: overdue ? "urgent" : "warning",
        title: overdue ? `Bill overdue — ${b.vendor}` : `Bill due soon — ${b.vendor}`,
        detail: money(b.amount.toString(), b.currency),
        href: "/spend/bills",
        date: b.dueDate.toISOString(),
      });
    }

    for (const budget of frozenBudgets) {
      notifications.push({
        id: `budget-frozen:${budget.id}`,
        severity: "warning",
        title: `Budget frozen — ${budget.name}`,
        detail: "Cards on this budget can't spend until it's unfrozen",
        href: "/spend/budgets",
        date: budget.createdAt.toISOString(),
      });
    }

    for (const r of pendingApprovals) {
      const meta: ApprovalMetadata = r.metadata ? JSON.parse(r.metadata) : {};
      const label = r.targetType === "CARD" ? meta.label ?? "Card" : meta.name ?? "Budget";
      const amount = r.targetType === "CARD" ? meta.spendLimit : meta.amount;
      notifications.push({
        id: `approval:${r.id}`,
        severity: "info",
        title: `${r.targetType === "CARD" ? "Card" : "Budget"} request — ${label}`,
        detail: amount ? `${money(amount, "USD")} · awaiting your approval` : "Awaiting your approval",
        href: r.targetType === "CARD" ? "/spend/cards" : "/spend/budgets",
        date: r.createdAt.toISOString(),
      });
    }

    for (const c of pendingClaims) {
      notifications.push({
        id: `claim:${c.id}`,
        severity: "info",
        title: `Claim awaiting approval — ${c.title}`,
        detail: `${money(c.amount.toString(), c.currency)} · awaiting your approval`,
        href: "/spend/claims",
        date: c.submittedAt.toISOString(),
      });
    }

    // User-configurable alerts (AlertRule) layer on top of the fixed
    // heuristics above: low-balance checks the current snapshot, large-
    // transaction checks debits from the last 24h so a threshold set today
    // doesn't dredge up the entire transaction history.
    const alertRules = await prisma.alertRule.findMany({ where: { companyId, active: true } });
    if (alertRules.length > 0) {
      const accounts = await prisma.account.findMany({ where: { companyId } });
      const accountMap = new Map(accounts.map((a) => [a.id, a]));

      for (const rule of alertRules.filter((r: (typeof alertRules)[number]) => r.type === "LOW_BALANCE")) {
        const targets = rule.accountId ? accounts.filter((a) => a.id === rule.accountId) : accounts;
        for (const acct of targets) {
          if (Number(acct.balance) < Number(rule.threshold)) {
            notifications.push({
              id: `alert-low-balance:${rule.id}:${acct.id}`,
              severity: "warning",
              title: `Low balance — ${acct.name}`,
              detail: `${money(acct.balance.toString(), acct.currency)} is below your ${money(
                rule.threshold.toString(),
                "USD"
              )} alert threshold`,
              href: "/accounts",
              date: now.toISOString(),
            });
          }
        }
      }

      const largeTxRules = alertRules.filter((r: (typeof alertRules)[number]) => r.type === "LARGE_TRANSACTION");
      if (largeTxRules.length > 0) {
        const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const accountIds = accounts.map((a) => a.id);
        const recentDebits = accountIds.length
          ? await prisma.transaction.findMany({
              where: { accountId: { in: accountIds }, type: "DEBIT", date: { gte: since } },
              orderBy: { date: "desc" },
            })
          : [];

        for (const rule of largeTxRules) {
          const targets = rule.accountId ? recentDebits.filter((t) => t.accountId === rule.accountId) : recentDebits;
          for (const t of targets) {
            if (Number(t.amount) > Number(rule.threshold)) {
              const acct = accountMap.get(t.accountId);
              notifications.push({
                id: `alert-large-tx:${rule.id}:${t.id}`,
                severity: "warning",
                title: `Large transaction — ${acct?.name ?? "Account"}`,
                detail: `${money(t.amount.toString(), t.currency)}${t.description ? " — " + t.description : ""}`,
                href: "/accounts",
                date: t.date.toISOString(),
              });
            }
          }
        }
      }
    }

    if (approvedCredit) {
      const company = await prisma.company.findUnique({ where: { id: companyId }, select: { contractAcceptedAt: true } });
      if (!company?.contractAcceptedAt) {
        notifications.push({
          id: `credit-contract:${approvedCredit.id}`,
          severity: "info",
          title: "Sign your lending contract",
          detail: `You have an approved credit line of ${money(
            (approvedCredit.approvedAmount ?? approvedCredit.requestedAmount).toString(),
            "USD"
          )} waiting`,
          href: "/credit",
          date: (approvedCredit.decidedAt ?? approvedCredit.createdAt).toISOString(),
        });
      }
    }

    const severityRank: Record<Severity, number> = { urgent: 0, warning: 1, info: 2 };
    notifications.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || (a.date < b.date ? 1 : -1));

    res.json({ notifications });
  })
);

export default router;
