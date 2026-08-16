import { BadRequestError, ConflictError, NotFoundError, UnprocessableEntityError } from "../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../shared/audit/audit.service";
import { INTERBANK_DAY_COUNT_BASIS, MIN_INTERBANK_LOAN_AMOUNT } from "./interbank.config";
import * as interbankRepo from "./interbank.repository";

/**
 * Business logic for the Interbank Lending / Treasury desk — every route in
 * interbank.routes.ts is a thin validate-then-call-this wrapper. All Prisma
 * access goes through interbank.repository.ts. Demo seeding lives in
 * interbank.demo.service.ts.
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The TreasuryBook is a singleton row representing LamBank's own lending
 * capital — separate from every customer Account. Lazily created with its
 * starting balance on first use, same pattern as getOrCreatePrimaryAccount
 * for a company's cash account.
 */
export async function getOrCreateTreasuryBook() {
  const existing = await interbankRepo.findTreasuryBook();
  if (existing) return existing;
  return interbankRepo.createTreasuryBook();
}

/**
 * Simple interest (ACT/365): principal * rate% * days/365. Used both to
 * quote a loan up front (over its full termDays) and to settle it (over the
 * actual days held, capped at termDays — see below).
 */
export function computeInterest(principal: number, interestRatePct: number, days: number): number {
  return round2(principal * (interestRatePct / 100) * (days / INTERBANK_DAY_COUNT_BASIS));
}

/**
 * Days actually held, for prorating interest at settlement: capped at the
 * agreed termDays so settling late doesn't keep accruing beyond what was
 * quoted, and at least 1 day so an instant same-day settlement still earns
 * something.
 */
export function daysHeld(startDate: Date, now: Date, termDays: number): number {
  const elapsed = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  return Math.min(termDays, Math.max(1, elapsed));
}

/** Sum of principal across a counterparty's currently-ACTIVE loans. */
export async function getCounterpartyExposure(counterpartyId: string): Promise<number> {
  const active = await interbankRepo.findActiveLoansByCounterparty(counterpartyId);
  return round2(active.reduce((sum: number, l: (typeof active)[number]) => sum + Number(l.principal), 0));
}

// --- Counterparty banks ------------------------------------------------------------

export async function listCounterparties() {
  const counterparties = await interbankRepo.findCounterparties();
  return Promise.all(
    counterparties.map(async (c: (typeof counterparties)[number]) => ({
      ...c,
      exposure: await getCounterpartyExposure(c.id),
    }))
  );
}

export interface CreateCounterpartyParams {
  name: string;
  swiftCode: string;
  creditLimit: number;
  notes?: string;
}

export async function createCounterparty(params: CreateCounterpartyParams, userId: string) {
  const { name, creditLimit, notes } = params;
  const swiftCode = params.swiftCode.toUpperCase();

  const existing = await interbankRepo.findCounterpartyBySwift(swiftCode);
  if (existing) {
    throw new ConflictError("A counterparty with this SWIFT code already exists");
  }

  const counterparty = await interbankRepo.createCounterparty({
    name,
    swiftCode,
    creditLimit,
    notes,
    createdById: userId,
  });

  await writeAuditLog({
    action: "COUNTERPARTY_BANK_CREATED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "CounterpartyBank",
    targetId: counterparty.id,
    metadata: { name, swiftCode: params.swiftCode, creditLimit: creditLimit.toString() },
  });

  return counterparty;
}

// --- Treasury book -------------------------------------------------------------------

export async function getTreasurySnapshot() {
  const book = await getOrCreateTreasuryBook();
  const [outstanding, transactions] = await Promise.all([
    interbankRepo.findActiveLoanPrincipals(),
    interbankRepo.findTreasuryTransactions(),
  ]);
  const totalOutstanding = outstanding.reduce(
    (sum: number, l: (typeof outstanding)[number]) => sum + Number(l.principal),
    0
  );
  return { balance: Number(book.balance), totalOutstanding, transactions };
}

// --- Interbank loans --------------------------------------------------------------------

export async function listLoans(status?: string) {
  const loans = await interbankRepo.findLoans(status as "ACTIVE" | "SETTLED" | "DEFAULTED" | undefined);
  const counterparties = await interbankRepo.findCounterpartiesByIds([
    ...new Set(loans.map((l: (typeof loans)[number]) => l.counterpartyId)),
  ]);
  const byId = new Map(counterparties.map((c: (typeof counterparties)[number]) => [c.id, c]));
  return loans.map((l: (typeof loans)[number]) => ({ ...l, counterparty: byId.get(l.counterpartyId) ?? null }));
}

export interface CreateLoanParams {
  counterpartyId: string;
  type: "UNSECURED" | "REPO";
  principal: number;
  interestRatePct: number;
  termDays: number;
  collateralDescription?: string;
  collateralValue?: number;
}

export async function bookLoan(params: CreateLoanParams, userId: string) {
  const { counterpartyId, type, principal, interestRatePct, termDays, collateralDescription, collateralValue } = params;

  if (principal < MIN_INTERBANK_LOAN_AMOUNT) {
    throw new UnprocessableEntityError(`Minimum interbank loan is $${MIN_INTERBANK_LOAN_AMOUNT.toLocaleString()}.`);
  }

  const counterparty = await interbankRepo.findCounterpartyById(counterpartyId);
  if (!counterparty) {
    throw new NotFoundError("Counterparty bank not found");
  }

  if (type === "REPO" && (!collateralDescription || !collateralValue)) {
    throw new BadRequestError("Repo loans require collateral description and value");
  }
  if (type === "REPO" && collateralValue! < principal) {
    throw new UnprocessableEntityError("Collateral value must cover at least the principal lent");
  }

  const exposure = await getCounterpartyExposure(counterpartyId);
  if (exposure + principal > Number(counterparty.creditLimit)) {
    throw new UnprocessableEntityError(
      `Exceeds this counterparty's credit limit (${(Number(counterparty.creditLimit) - exposure).toFixed(2)} available).`
    );
  }

  const book = await getOrCreateTreasuryBook();
  if (Number(book.balance) < principal) {
    throw new UnprocessableEntityError("Insufficient treasury capital to lend this amount");
  }

  const startDate = new Date();
  const maturityDate = new Date(startDate.getTime() + termDays * 24 * 60 * 60 * 1000);

  const loan = await interbankRepo.runInTransaction(async (tx) => {
    await interbankRepo.adjustTreasuryBalance(book.id, -principal, tx);
    const created = await interbankRepo.createLoan(
      {
        counterpartyId,
        type,
        principal,
        interestRatePct,
        termDays,
        startDate,
        maturityDate,
        collateralDescription: type === "REPO" ? collateralDescription : undefined,
        collateralValue: type === "REPO" ? collateralValue : undefined,
        createdById: userId,
      },
      tx
    );
    await interbankRepo.createTreasuryTransaction(
      {
        amount: principal,
        type: "DEBIT",
        description: `Interbank loan to ${counterparty.name} (${counterparty.swiftCode})`,
        interbankLoanId: created.id,
      },
      tx
    );
    return created;
  });

  await writeAuditLog({
    action: "INTERBANK_LOAN_BOOKED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "InterbankLoan",
    targetId: loan.id,
    metadata: { counterpartyId, type, principal: principal.toString(), interestRatePct, termDays },
  });

  return loan;
}

export async function settleLoan(loanId: string, userId: string) {
  const loan = await interbankRepo.findLoanById(loanId);
  if (!loan) {
    throw new NotFoundError("Loan not found");
  }
  if (loan.status !== "ACTIVE") {
    throw new BadRequestError("Only an active loan can be settled");
  }

  const counterparty = await interbankRepo.findCounterpartyById(loan.counterpartyId);
  const held = daysHeld(loan.startDate, new Date(), loan.termDays);
  const interest = computeInterest(Number(loan.principal), Number(loan.interestRatePct), held);
  const totalReceived = Number(loan.principal) + interest;

  const book = await getOrCreateTreasuryBook();

  await interbankRepo.runInTransaction(async (tx) => {
    await interbankRepo.adjustTreasuryBalance(book.id, totalReceived, tx);
    await interbankRepo.settleLoan(loan.id, interest, tx);
    await interbankRepo.createTreasuryTransaction(
      {
        amount: totalReceived,
        type: "CREDIT",
        description: `Interbank loan settled — ${counterparty?.name ?? "counterparty"} (principal ${Number(
          loan.principal
        ).toFixed(2)} + interest ${interest.toFixed(2)})`,
        interbankLoanId: loan.id,
      },
      tx
    );
  });

  await writeAuditLog({
    action: "INTERBANK_LOAN_SETTLED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "InterbankLoan",
    targetId: loan.id,
    metadata: { principal: loan.principal.toString(), interest: interest.toString(), daysHeld: held },
  });

  return { ...loan, status: "SETTLED" as const, interestReceived: interest };
}

export async function markLoanDefaulted(loanId: string, userId: string) {
  const loan = await interbankRepo.findLoanById(loanId);
  if (!loan) {
    throw new NotFoundError("Loan not found");
  }
  if (loan.status !== "ACTIVE") {
    throw new BadRequestError("Only an active loan can be marked as defaulted");
  }

  // No cash comes back — the principal already lent out is a realized loss.
  // Nothing to book against TreasuryBook beyond what was already debited
  // when the loan was originated.
  const updated = await interbankRepo.defaultLoan(loan.id);

  await writeAuditLog({
    action: "INTERBANK_LOAN_DEFAULTED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "InterbankLoan",
    targetId: loan.id,
    metadata: { principal: loan.principal.toString() },
  });

  return updated;
}
