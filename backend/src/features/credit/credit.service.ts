import {
  findActiveCreditApply,
  findFirstAccountByCompany,
  createAccount,
  findAccountIdsByCompany,
  findTransactionsSince,
  findOverdueBills,
  findDrawdownsByCreditApply,
  findRepaymentsByCreditApply,
  findCompanyKybAndContract,
  findDrawdownIdsByCompany,
  findOverdueInstallment,
  countUnfrozenAccounts,
} from "./credit.repository";

const RISK_LOOKBACK_MONTHS = 3;

export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * A company has at most one CreditApply that is PENDING_MAKER, PENDING_CHECKER,
 * or APPROVED at any time (its single revolving credit line). Returns that
 * row, if any.
 */
export async function getActiveCreditApply(companyId: string) {
  return findActiveCreditApply(companyId);
}

export function availableAmount(creditApply: { approvedAmount: unknown; drawnAmount: unknown } | null): number {
  if (!creditApply || creditApply.approvedAmount == null) return 0;
  return Number(creditApply.approvedAmount) - Number(creditApply.drawnAmount);
}

/**
 * Every company should have a primary cash Account before money can be
 * drawn into it. `/auth/register` already creates one for new companies,
 * but this stays as a defensive fallback for any company that predates
 * that change (or was seeded directly) so drawdown never has nowhere to land.
 */
export async function getOrCreatePrimaryAccount(companyId: string) {
  const existing = await findFirstAccountByCompany(companyId);
  if (existing) return existing;

  const accountNumber = `US-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;
  return createAccount({ name: "Cash Account", currency: "USD", balance: 0, accountNumber, companyId });
}

export interface CreditRiskSnapshot {
  lookbackMonths: number;
  avgMonthlyInflow: number;
  avgMonthlyOutflow: number;
  netMonthlyCashFlow: number;
  overdueBillsCount: number;
  overdueBillsAmount: number;
  requestedToInflowRatio: number | null;
  riskBand: "LOW" | "MEDIUM" | "HIGH";
  notes: string[];
}

/**
 * A lightweight, explainable stand-in for real credit scoring/underwriting
 * data (bureau pulls, income docs, etc — all out of scope for this demo).
 * Built entirely from data already in the system: recent cash flow through
 * the company's own accounts, and any bills currently overdue. Meant as
 * decision support shown to the checker/maker during review, not a hard
 * gate — LamBank's actual approve/reject decision stays a human call.
 */
export async function getCreditRiskSnapshot(companyId: string, requestedAmount: number): Promise<CreditRiskSnapshot> {
  const accounts = await findAccountIdsByCompany(companyId);
  const accountIds = accounts.map((a) => a.id);

  const since = addMonths(new Date(), -RISK_LOOKBACK_MONTHS);
  const transactions = accountIds.length ? await findTransactionsSince(accountIds, since) : [];

  const totalIn = transactions.filter((t) => t.type === "CREDIT").reduce((sum, t) => sum + Number(t.amount), 0);
  const totalOut = transactions.filter((t) => t.type === "DEBIT").reduce((sum, t) => sum + Number(t.amount), 0);
  const avgMonthlyInflow = totalIn / RISK_LOOKBACK_MONTHS;
  const avgMonthlyOutflow = totalOut / RISK_LOOKBACK_MONTHS;
  const netMonthlyCashFlow = avgMonthlyInflow - avgMonthlyOutflow;

  const overdueBills = await findOverdueBills(companyId, new Date());
  const overdueBillsCount = overdueBills.length;
  const overdueBillsAmount = overdueBills.reduce((sum, b) => sum + Number(b.amount), 0);

  const requestedToInflowRatio = avgMonthlyInflow > 0 ? requestedAmount / avgMonthlyInflow : null;

  const notes: string[] = [];
  let riskBand: CreditRiskSnapshot["riskBand"] = "LOW";

  if (netMonthlyCashFlow < 0) {
    riskBand = "HIGH";
    notes.push("Money out has exceeded money in over the last 3 months.");
  }
  if (overdueBillsCount > 0) {
    riskBand = "HIGH";
    notes.push(`${overdueBillsCount} bill${overdueBillsCount === 1 ? " is" : "s are"} currently overdue.`);
  }
  if (requestedToInflowRatio !== null && requestedToInflowRatio > 6) {
    riskBand = "HIGH";
    notes.push("Requested amount is more than 6x average monthly inflow.");
  } else if (requestedToInflowRatio !== null && requestedToInflowRatio > 3 && riskBand === "LOW") {
    riskBand = "MEDIUM";
    notes.push("Requested amount is more than 3x average monthly inflow.");
  }
  if (avgMonthlyInflow === 0 && riskBand === "LOW") {
    riskBand = "MEDIUM";
    notes.push("No inflow activity in the lookback window yet — limited history to assess.");
  }
  if (notes.length === 0) {
    notes.push("Healthy cash flow, no overdue bills, requested amount in line with inflow.");
  }

  return {
    lookbackMonths: RISK_LOOKBACK_MONTHS,
    avgMonthlyInflow,
    avgMonthlyOutflow,
    netMonthlyCashFlow,
    overdueBillsCount,
    overdueBillsAmount,
    requestedToInflowRatio,
    riskBand,
    notes,
  };
}

export interface CreditMonitoring {
  outstandingPrincipal: number;
  nextDueDate: string | null;
  isOverdue: boolean;
  daysUntilDue: number | null;
}

/**
 * Repayments aren't tied to a specific Drawdown — they just pay down the
 * pooled `drawnAmount` on the CreditApply. To surface a "next payment due"
 * date anyway, walk drawdowns oldest-first and apply cumulative repayments
 * FIFO; the first drawdown not fully covered is the one driving the next
 * due date (createdAt + its termMonths).
 */
export async function getCreditMonitoring(creditApplyId: string): Promise<CreditMonitoring> {
  const [drawdowns, repayments] = await Promise.all([
    findDrawdownsByCreditApply(creditApplyId),
    findRepaymentsByCreditApply(creditApplyId),
  ]);

  const totalRepaid = repayments.reduce((sum, r) => sum + Number(r.amount), 0);
  let remainingRepayment = totalRepaid;
  let outstandingPrincipal = 0;
  let nextDueDate: Date | null = null;

  for (const d of drawdowns) {
    const amount = Number(d.amount);
    const covered = Math.min(amount, remainingRepayment);
    remainingRepayment -= covered;
    const outstandingOnThis = amount - covered;
    outstandingPrincipal += outstandingOnThis;
    if (outstandingOnThis > 0 && nextDueDate === null) {
      nextDueDate = new Date(d.maturityDate);
    }
  }

  const now = new Date();
  const isOverdue = !!nextDueDate && nextDueDate.getTime() < now.getTime() && outstandingPrincipal > 0;
  const daysUntilDue = nextDueDate
    ? Math.ceil((nextDueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return {
    outstandingPrincipal,
    nextDueDate: nextDueDate ? nextDueDate.toISOString() : null,
    isOverdue,
    daysUntilDue,
  };
}

export interface DrawdownConditions {
  kybApproved: boolean;
  contractSigned: boolean;
  creditApproved: boolean;
  noOverduePayments: boolean;
  accountAvailable: boolean;
  allMet: boolean;
}

/**
 * The "conditions precedent" a real facility checks before releasing funds
 * on a drawdown. LamBank has no manual underwriting queue for this — every
 * condition here is something already tracked elsewhere in the app, so it's
 * evaluated automatically rather than as a signed checklist.
 */
export async function getDrawdownConditions(companyId: string): Promise<DrawdownConditions> {
  const company = await findCompanyKybAndContract(companyId);
  const creditApply = await getActiveCreditApply(companyId);

  const kybApproved = company?.kybStatus === "APPROVED";
  const contractSigned = !!company?.contractAcceptedAt;
  const creditApproved = creditApply?.status === "APPROVED";

  let noOverduePayments = true;
  if (creditApproved && creditApply) {
    const monitoring = await getCreditMonitoring(creditApply.id);
    noOverduePayments = !monitoring.isOverdue;
  }
  if (noOverduePayments) {
    // Scheduled drawdowns (AMORTIZING/INTEREST_ONLY/BALLOON) track overdue-ness
    // per installment rather than through the pooled FIFO estimate above —
    // check those directly so a missed installment blocks further drawdowns
    // too. Installment has no Prisma relation back to Drawdown (this schema
    // uses raw id columns instead of @relation FKs throughout), so the
    // company scope is resolved as a two-step lookup.
    const drawdownIds = (await findDrawdownIdsByCompany(companyId)).map((d) => d.id);
    const overdueInstallment = drawdownIds.length > 0 ? await findOverdueInstallment(drawdownIds, new Date()) : null;
    noOverduePayments = !overdueInstallment;
  }

  const accountAvailable = (await countUnfrozenAccounts(companyId)) > 0;

  return {
    kybApproved,
    contractSigned,
    creditApproved: !!creditApproved,
    noOverduePayments,
    accountAvailable,
    allMet: kybApproved && contractSigned && !!creditApproved && noOverduePayments && accountAvailable,
  };
}
