import { hasApprovalPower } from "../../../middleware/companyAdmin";
import * as notificationsRepo from "./notifications.repository";

/**
 * Builds the notification bell's contents. Everything here is computed on
 * the fly from existing tables (bills, budgets, approval requests, claims,
 * alert rules, credit) rather than a separate Notification table — same
 * "derive, don't persist" approach used for recent transfer recipients.
 * This consolidates alerts that used to be scattered across separate pages
 * (KybBanner keeps handling the business-verification reminder on its own,
 * since that's already a persistent top-of-page banner).
 */

type Severity = "info" | "warning" | "urgent";

export interface Notification {
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

/** How far ahead a bill counts as "due soon". */
const DUE_SOON_DAYS = 7;

/** Large-transaction alerts only look at the last day, so a threshold set today doesn't dredge up all history. */
const LARGE_TX_LOOKBACK_HOURS = 24;

export async function listNotifications(companyId: string, userId: string): Promise<Notification[]> {
  const user = await notificationsRepo.findUserById(userId);
  const canApprove = hasApprovalPower(user);

  const now = new Date();
  const dueSoonCutoff = new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000);

  const [bills, frozenBudgets, pendingApprovals, pendingClaims, approvedCredit] = await Promise.all([
    notificationsRepo.findBillsDueBy(companyId, dueSoonCutoff),
    notificationsRepo.findFrozenBudgets(companyId),
    canApprove ? notificationsRepo.findPendingApprovals(companyId) : Promise.resolve([]),
    canApprove ? notificationsRepo.findPendingClaims(companyId) : Promise.resolve([]),
    notificationsRepo.findLatestApprovedCredit(companyId),
  ]);

  const notifications: Notification[] = [];

  for (const bill of bills) {
    const overdue = bill.status === "OVERDUE" || new Date(bill.dueDate) < now;
    notifications.push({
      id: `bill:${bill.id}`,
      severity: overdue ? "urgent" : "warning",
      title: overdue ? `Bill overdue — ${bill.vendor}` : `Bill due soon — ${bill.vendor}`,
      detail: money(bill.amount.toString(), bill.currency),
      href: "/spend/bills",
      date: bill.dueDate.toISOString(),
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

  for (const approvalRequest of pendingApprovals) {
    const requestMetadata: ApprovalMetadata = approvalRequest.metadata ? JSON.parse(approvalRequest.metadata) : {};
    const label = approvalRequest.targetType === "CARD" ? requestMetadata.label ?? "Card" : requestMetadata.name ?? "Budget";
    const amount = approvalRequest.targetType === "CARD" ? requestMetadata.spendLimit : requestMetadata.amount;
    notifications.push({
      id: `approval:${approvalRequest.id}`,
      severity: "info",
      title: `${approvalRequest.targetType === "CARD" ? "Card" : "Budget"} request — ${label}`,
      detail: amount ? `${money(amount, "USD")} · awaiting your approval` : "Awaiting your approval",
      href: approvalRequest.targetType === "CARD" ? "/spend/cards" : "/spend/budgets",
      date: approvalRequest.createdAt.toISOString(),
    });
  }

  for (const claim of pendingClaims) {
    notifications.push({
      id: `claim:${claim.id}`,
      severity: "info",
      title: `Claim awaiting approval — ${claim.title}`,
      detail: `${money(claim.amount.toString(), claim.currency)} · awaiting your approval`,
      href: "/spend/claims",
      date: claim.submittedAt.toISOString(),
    });
  }

  notifications.push(...(await buildAlertRuleNotifications(companyId, now)));

  if (approvedCredit) {
    const company = await notificationsRepo.findCompanyContract(companyId);
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
  notifications.sort((notificationA, notificationB) => severityRank[notificationA.severity] - severityRank[notificationB.severity] || (notificationA.date < notificationB.date ? 1 : -1));

  return notifications;
}

/**
 * User-configurable alerts (AlertRule) layered on top of the fixed
 * heuristics above: low-balance checks the current snapshot, large-
 * transaction checks debits from the last 24h so a threshold set today
 * doesn't dredge up the entire transaction history.
 */
async function buildAlertRuleNotifications(companyId: string, now: Date): Promise<Notification[]> {
  const alertRules = await notificationsRepo.findActiveAlertRules(companyId);
  if (alertRules.length === 0) return [];

  const notifications: Notification[] = [];
  const accounts = await notificationsRepo.findAccounts(companyId);
  const accountMap = new Map(accounts.map((account) => [account.id, account]));

  for (const rule of alertRules.filter((rule: (typeof alertRules)[number]) => rule.type === "LOW_BALANCE")) {
    const targets = rule.accountId ? accounts.filter((account) => account.id === rule.accountId) : accounts;
    for (const account of targets) {
      if (Number(account.balance) < Number(rule.threshold)) {
        notifications.push({
          id: `alert-low-balance:${rule.id}:${account.id}`,
          severity: "warning",
          title: `Low balance — ${account.name}`,
          detail: `${money(account.balance.toString(), account.currency)} is below your ${money(
            rule.threshold.toString(),
            "USD"
          )} alert threshold`,
          href: "/accounts",
          date: now.toISOString(),
        });
      }
    }
  }

  const largeTxRules = alertRules.filter((rule: (typeof alertRules)[number]) => rule.type === "LARGE_TRANSACTION");
  if (largeTxRules.length > 0) {
    const since = new Date(now.getTime() - LARGE_TX_LOOKBACK_HOURS * 60 * 60 * 1000);
    const accountIds = accounts.map((account) => account.id);
    const recentDebits = accountIds.length ? await notificationsRepo.findRecentDebits(accountIds, since) : [];

    for (const rule of largeTxRules) {
      const targets = rule.accountId ? recentDebits.filter((debit) => debit.accountId === rule.accountId) : recentDebits;
      for (const debit of targets) {
        if (Number(debit.amount) > Number(rule.threshold)) {
          const account = accountMap.get(debit.accountId);
          notifications.push({
            id: `alert-large-tx:${rule.id}:${debit.id}`,
            severity: "warning",
            title: `Large transaction — ${account?.name ?? "Account"}`,
            detail: `${money(debit.amount.toString(), debit.currency)}${debit.description ? " — " + debit.description : ""}`,
            href: "/accounts",
            date: debit.date.toISOString(),
          });
        }
      }
    }
  }

  return notifications;
}
