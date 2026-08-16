import { writeAuditLog, resolveActorEmail } from "../../shared/audit/audit.service";
import * as interbankRepo from "./interbank.repository";
import { computeInterest, getOrCreateTreasuryBook } from "./interbank.service";

/**
 * Sandbox-only treasury seeding, kept out of interbank.service.ts so demo
 * data can't be confused with real loan booking. Mounted behind an
 * `isProduction` guard — see interbank.demo.routes.ts.
 */

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

/**
 * Books a handful of counterparty banks and loans in a mix of statuses
 * (active, settled, defaulted) so the page isn't empty on a fresh database —
 * same spirit as the "reset demo data" buttons elsewhere in the app, except
 * this seeds rather than clears. Idempotent: does nothing if any
 * counterparty already exists, so it's safe to click more than once and
 * never creates duplicates.
 */
export async function seedDemoTreasury(userId: string): Promise<{ seeded: boolean; message?: string; bookId: string }> {
  const existing = await interbankRepo.countCounterparties();
  const book = await getOrCreateTreasuryBook();

  if (existing > 0) {
    return { seeded: false, message: "Demo data already exists.", bookId: book.id };
  }

  await interbankRepo.runInTransaction(async (tx) => {
    const pacific = await interbankRepo.createCounterparty(
      {
        name: "Pacific National Bank",
        swiftCode: "PNBKUS33",
        creditLimit: 5_000_000,
        notes: "Correspondent relationship since 2019.",
        createdById: userId,
      },
      tx
    );
    const meridian = await interbankRepo.createCounterparty(
      {
        name: "Meridian Trust Bank",
        swiftCode: "MERDGB2L",
        creditLimit: 3_000_000,
        notes: "Repo counterparty, UK.",
        createdById: userId,
      },
      tx
    );
    const sunrise = await interbankRepo.createCounterparty(
      {
        name: "Sunrise Commercial Bank",
        swiftCode: "SUNRJPJT",
        creditLimit: 2_000_000,
        notes: null,
        createdById: userId,
      },
      tx
    );

    // 1. Active unsecured loan.
    const activeStart = daysAgo(10);
    const loan1Principal = 500_000;
    await interbankRepo.createLoan(
      {
        counterpartyId: pacific.id,
        type: "UNSECURED",
        principal: loan1Principal,
        interestRatePct: 4.5,
        termDays: 30,
        startDate: activeStart,
        maturityDate: new Date(activeStart.getTime() + 30 * 24 * 60 * 60 * 1000),
        createdById: userId,
      },
      tx
    );
    await interbankRepo.createTreasuryTransaction(
      {
        amount: loan1Principal,
        type: "DEBIT",
        description: `Interbank loan to ${pacific.name} (${pacific.swiftCode})`,
        createdAt: activeStart,
      },
      tx
    );

    // 2. Active repo loan, collateralized.
    const repoStart = daysAgo(20);
    const loan2Principal = 750_000;
    await interbankRepo.createLoan(
      {
        counterpartyId: meridian.id,
        type: "REPO",
        principal: loan2Principal,
        interestRatePct: 3.8,
        termDays: 90,
        startDate: repoStart,
        maturityDate: new Date(repoStart.getTime() + 90 * 24 * 60 * 60 * 1000),
        collateralDescription: "US Treasury bonds, 2Y",
        collateralValue: 800_000,
        createdById: userId,
      },
      tx
    );
    await interbankRepo.createTreasuryTransaction(
      {
        amount: loan2Principal,
        type: "DEBIT",
        description: `Interbank loan to ${meridian.name} (${meridian.swiftCode})`,
        createdAt: repoStart,
      },
      tx
    );

    // 3. Settled loan — already matured and repaid with interest.
    const settledStart = daysAgo(45);
    const settledMaturity = new Date(settledStart.getTime() + 30 * 24 * 60 * 60 * 1000);
    const loan3Principal = 300_000;
    const loan3Interest = computeInterest(loan3Principal, 5, 30);
    const loan3 = await interbankRepo.createLoan(
      {
        counterpartyId: sunrise.id,
        type: "UNSECURED",
        principal: loan3Principal,
        interestRatePct: 5,
        termDays: 30,
        startDate: settledStart,
        maturityDate: settledMaturity,
        status: "SETTLED",
        interestReceived: loan3Interest,
        settledAt: settledMaturity,
        createdById: userId,
      },
      tx
    );
    await interbankRepo.createTreasuryTransaction(
      {
        amount: loan3Principal,
        type: "DEBIT",
        description: `Interbank loan to ${sunrise.name} (${sunrise.swiftCode})`,
        interbankLoanId: loan3.id,
        createdAt: settledStart,
      },
      tx
    );
    await interbankRepo.createTreasuryTransaction(
      {
        amount: loan3Principal + loan3Interest,
        type: "CREDIT",
        description: `Interbank loan settled — ${sunrise.name} (principal ${loan3Principal.toFixed(
          2
        )} + interest ${loan3Interest.toFixed(2)})`,
        interbankLoanId: loan3.id,
        createdAt: settledMaturity,
      },
      tx
    );

    // 4. Defaulted repo loan — principal written off, no cash returns.
    const defaultStart = daysAgo(60);
    const loan4Principal = 200_000;
    const loan4 = await interbankRepo.createLoan(
      {
        counterpartyId: pacific.id,
        type: "REPO",
        principal: loan4Principal,
        interestRatePct: 6,
        termDays: 30,
        startDate: defaultStart,
        maturityDate: new Date(defaultStart.getTime() + 30 * 24 * 60 * 60 * 1000),
        collateralDescription: "Corporate bonds (insufficient recovery)",
        collateralValue: 150_000,
        status: "DEFAULTED",
        defaultedAt: daysAgo(25),
        createdById: userId,
      },
      tx
    );
    await interbankRepo.createTreasuryTransaction(
      {
        amount: loan4Principal,
        type: "DEBIT",
        description: `Interbank loan to ${pacific.name} (${pacific.swiftCode})`,
        interbankLoanId: loan4.id,
        createdAt: defaultStart,
      },
      tx
    );

    // Net treasury balance change: -loan1 -loan2 -loan3 +loan3Interest -loan4
    // (loan3's principal both leaves and returns; loan4's principal is a
    // realized loss, matching the same accounting the real settle/default
    // routes use).
    const netChange = -loan1Principal - loan2Principal + loan3Interest - loan4Principal;
    await interbankRepo.adjustTreasuryBalance(book.id, netChange, tx);
  });

  await writeAuditLog({
    action: "INTERBANK_DEMO_SEEDED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "TreasuryBook",
    targetId: book.id,
  });

  return { seeded: true, bookId: book.id };
}
