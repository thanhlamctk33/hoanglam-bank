import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { BadRequestError, ConflictError, NotFoundError, UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { getOrCreateTreasuryBook, computeInterest, daysHeld, getCounterpartyExposure } from "./interbank.service";
import { MIN_INTERBANK_LOAN_AMOUNT, INTERBANK_TERM_OPTIONS } from "./interbank.config";

// Interbank Lending / Treasury desk — LamBank lending its own capital to
// other banks. No customer company is involved on either leg of these
// loans (CounterpartyBank/InterbankLoan/TreasuryBook carry no companyId —
// they're global to the bank, not scoped per company). Originally
// staff-only; opened up to any company Admin too so it's reachable as a
// demo/learning feature from a normal account, same trust level as any
// other admin-only action in this app (requireCompanyAdmin = isStaff OR
// company ADMIN). Every company Admin sees the same global treasury data —
// that's intentional for this demo, not a per-tenant view.
const router = Router();
router.use(requireAuth, requireCompanyAdmin);

async function actorEmail(userId?: string): Promise<string> {
  if (!userId) return "unknown";
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user?.email ?? "unknown";
}

router.get(
  "/term-options",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    res.json({ termOptions: INTERBANK_TERM_OPTIONS });
  })
);

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// Testing/demo convenience: books a handful of counterparty banks and loans
// in a mix of statuses (active, settled, defaulted) so the page isn't empty
// on a fresh database — same spirit as the "reset demo data" buttons
// elsewhere in the app, except this seeds rather than clears. Idempotent:
// does nothing if any counterparty already exists, so it's safe to click
// more than once and never creates duplicates.
router.post(
  "/seed-demo",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const existing = await prisma.counterpartyBank.count();
    if (existing > 0) {
      return res.json({ ok: true, seeded: false, message: "Demo data already exists." });
    }

    const book = await getOrCreateTreasuryBook();

    await prisma.$transaction(async (tx) => {
      const pacific = await tx.counterpartyBank.create({
        data: {
          name: "Pacific National Bank",
          swiftCode: "PNBKUS33",
          creditLimit: 5_000_000,
          notes: "Correspondent relationship since 2019.",
          createdById: req.userId!,
        },
      });
      const meridian = await tx.counterpartyBank.create({
        data: {
          name: "Meridian Trust Bank",
          swiftCode: "MERDGB2L",
          creditLimit: 3_000_000,
          notes: "Repo counterparty, UK.",
          createdById: req.userId!,
        },
      });
      const sunrise = await tx.counterpartyBank.create({
        data: {
          name: "Sunrise Commercial Bank",
          swiftCode: "SUNRJPJT",
          creditLimit: 2_000_000,
          notes: null,
          createdById: req.userId!,
        },
      });

      // 1. Active unsecured loan.
      const activeStart = daysAgo(10);
      const loan1Principal = 500_000;
      await tx.interbankLoan.create({
        data: {
          counterpartyId: pacific.id,
          type: "UNSECURED",
          principal: loan1Principal,
          interestRatePct: 4.5,
          termDays: 30,
          startDate: activeStart,
          maturityDate: new Date(activeStart.getTime() + 30 * 24 * 60 * 60 * 1000),
          createdById: req.userId!,
        },
      });
      await tx.treasuryTransaction.create({
        data: {
          amount: loan1Principal,
          type: "DEBIT",
          description: `Interbank loan to ${pacific.name} (${pacific.swiftCode})`,
          createdAt: activeStart,
        },
      });

      // 2. Active repo loan, collateralized.
      const repoStart = daysAgo(20);
      const loan2Principal = 750_000;
      await tx.interbankLoan.create({
        data: {
          counterpartyId: meridian.id,
          type: "REPO",
          principal: loan2Principal,
          interestRatePct: 3.8,
          termDays: 90,
          startDate: repoStart,
          maturityDate: new Date(repoStart.getTime() + 90 * 24 * 60 * 60 * 1000),
          collateralDescription: "US Treasury bonds, 2Y",
          collateralValue: 800_000,
          createdById: req.userId!,
        },
      });
      await tx.treasuryTransaction.create({
        data: {
          amount: loan2Principal,
          type: "DEBIT",
          description: `Interbank loan to ${meridian.name} (${meridian.swiftCode})`,
          createdAt: repoStart,
        },
      });

      // 3. Settled loan — already matured and repaid with interest.
      const settledStart = daysAgo(45);
      const settledMaturity = new Date(settledStart.getTime() + 30 * 24 * 60 * 60 * 1000);
      const loan3Principal = 300_000;
      const loan3Interest = computeInterest(loan3Principal, 5, 30);
      const loan3 = await tx.interbankLoan.create({
        data: {
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
          createdById: req.userId!,
        },
      });
      await tx.treasuryTransaction.create({
        data: {
          amount: loan3Principal,
          type: "DEBIT",
          description: `Interbank loan to ${sunrise.name} (${sunrise.swiftCode})`,
          interbankLoanId: loan3.id,
          createdAt: settledStart,
        },
      });
      await tx.treasuryTransaction.create({
        data: {
          amount: loan3Principal + loan3Interest,
          type: "CREDIT",
          description: `Interbank loan settled — ${sunrise.name} (principal ${loan3Principal.toFixed(2)} + interest ${loan3Interest.toFixed(2)})`,
          interbankLoanId: loan3.id,
          createdAt: settledMaturity,
        },
      });

      // 4. Defaulted repo loan — principal written off, no cash returns.
      const defaultStart = daysAgo(60);
      const loan4Principal = 200_000;
      const loan4 = await tx.interbankLoan.create({
        data: {
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
          createdById: req.userId!,
        },
      });
      await tx.treasuryTransaction.create({
        data: {
          amount: loan4Principal,
          type: "DEBIT",
          description: `Interbank loan to ${pacific.name} (${pacific.swiftCode})`,
          interbankLoanId: loan4.id,
          createdAt: defaultStart,
        },
      });

      // Net treasury balance change: -loan1 -loan2 -loan3 +loan3Interest -loan4
      // (loan3's principal both leaves and returns; loan4's principal is a
      // realized loss, matching the same accounting the real settle/default
      // routes use).
      const netChange = -loan1Principal - loan2Principal + loan3Interest - loan4Principal;
      await tx.treasuryBook.update({ where: { id: book.id }, data: { balance: { increment: netChange } } });
    });

    await writeAuditLog({
      action: "INTERBANK_DEMO_SEEDED",
      actorEmail: await actorEmail(req.userId),
      targetType: "TreasuryBook",
      targetId: book.id,
    });

    res.json({ ok: true, seeded: true });
  })
);

// --- Counterparty banks ---

router.get(
  "/counterparties",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    const counterparties = await prisma.counterpartyBank.findMany({ orderBy: { createdAt: "desc" } });
    const withExposure = await Promise.all(
      counterparties.map(async (c: (typeof counterparties)[number]) => ({
        ...c,
        exposure: await getCounterpartyExposure(c.id),
      }))
    );
    res.json({ counterparties: withExposure });
  })
);

const createCounterpartySchema = z.object({
  name: z.string().min(1).max(120),
  swiftCode: z.string().min(4).max(20),
  creditLimit: z.number().positive(),
  notes: z.string().max(500).optional(),
});

router.post(
  "/counterparties",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createCounterpartySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { name, swiftCode, creditLimit, notes } = parsed.data;

    const existing = await prisma.counterpartyBank.findUnique({ where: { swiftCode: swiftCode.toUpperCase() } });
    if (existing) {
      throw new ConflictError("A counterparty with this SWIFT code already exists");
    }

    const counterparty = await prisma.counterpartyBank.create({
      data: { name, swiftCode: swiftCode.toUpperCase(), creditLimit, notes, createdById: req.userId! },
    });

    await writeAuditLog({
      action: "COUNTERPARTY_BANK_CREATED",
      actorEmail: await actorEmail(req.userId),
      targetType: "CounterpartyBank",
      targetId: counterparty.id,
      metadata: { name, swiftCode, creditLimit: creditLimit.toString() },
    });

    res.status(201).json({ counterparty });
  })
);

// --- Treasury book ---

router.get(
  "/treasury",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    const book = await getOrCreateTreasuryBook();
    const [outstanding, transactions] = await Promise.all([
      prisma.interbankLoan.findMany({ where: { status: "ACTIVE" }, select: { principal: true } }),
      prisma.treasuryTransaction.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    const totalOutstanding = outstanding.reduce(
      (sum: number, l: (typeof outstanding)[number]) => sum + Number(l.principal),
      0
    );
    res.json({ balance: Number(book.balance), totalOutstanding, transactions });
  })
);

// --- Interbank loans ---

router.get(
  "/loans",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    const loans = await prisma.interbankLoan.findMany({
      where: statusFilter ? { status: statusFilter as "ACTIVE" | "SETTLED" | "DEFAULTED" } : undefined,
      orderBy: { createdAt: "desc" },
    });
    const counterparties = await prisma.counterpartyBank.findMany({
      where: { id: { in: [...new Set(loans.map((l: (typeof loans)[number]) => l.counterpartyId))] } },
    });
    const byId = new Map(counterparties.map((c: (typeof counterparties)[number]) => [c.id, c]));
    res.json({
      loans: loans.map((l: (typeof loans)[number]) => ({ ...l, counterparty: byId.get(l.counterpartyId) ?? null })),
    });
  })
);

const createLoanSchema = z.object({
  counterpartyId: z.string().uuid(),
  type: z.enum(["UNSECURED", "REPO"]).default("UNSECURED"),
  principal: z.number().positive(),
  interestRatePct: z.number().min(0).max(100),
  termDays: z.number().int().positive(),
  collateralDescription: z.string().max(300).optional(),
  collateralValue: z.number().positive().optional(),
});

router.post(
  "/loans",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createLoanSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { counterpartyId, type, principal, interestRatePct, termDays, collateralDescription, collateralValue } =
      parsed.data;

    if (principal < MIN_INTERBANK_LOAN_AMOUNT) {
      throw new UnprocessableEntityError(`Minimum interbank loan is $${MIN_INTERBANK_LOAN_AMOUNT.toLocaleString()}.`);
    }

    const counterparty = await prisma.counterpartyBank.findUnique({ where: { id: counterpartyId } });
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

    const loan = await prisma.$transaction(async (tx) => {
      await tx.treasuryBook.update({ where: { id: book.id }, data: { balance: { decrement: principal } } });
      const created = await tx.interbankLoan.create({
        data: {
          counterpartyId,
          type,
          principal,
          interestRatePct,
          termDays,
          startDate,
          maturityDate,
          collateralDescription: type === "REPO" ? collateralDescription : undefined,
          collateralValue: type === "REPO" ? collateralValue : undefined,
          createdById: req.userId!,
        },
      });
      await tx.treasuryTransaction.create({
        data: {
          amount: principal,
          type: "DEBIT",
          description: `Interbank loan to ${counterparty.name} (${counterparty.swiftCode})`,
          interbankLoanId: created.id,
        },
      });
      return created;
    });

    await writeAuditLog({
      action: "INTERBANK_LOAN_BOOKED",
      actorEmail: await actorEmail(req.userId),
      targetType: "InterbankLoan",
      targetId: loan.id,
      metadata: { counterpartyId, type, principal: principal.toString(), interestRatePct, termDays },
    });

    res.status(201).json({ loan });
  })
);

router.post(
  "/loans/:id/settle",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const loan = await prisma.interbankLoan.findUnique({ where: { id: req.params.id } });
    if (!loan) {
      throw new NotFoundError("Loan not found");
    }
    if (loan.status !== "ACTIVE") {
      throw new BadRequestError("Only an active loan can be settled");
    }

    const counterparty = await prisma.counterpartyBank.findUnique({ where: { id: loan.counterpartyId } });
    const held = daysHeld(loan.startDate, new Date(), loan.termDays);
    const interest = computeInterest(Number(loan.principal), Number(loan.interestRatePct), held);
    const totalReceived = Number(loan.principal) + interest;

    const book = await getOrCreateTreasuryBook();

    await prisma.$transaction(async (tx) => {
      await tx.treasuryBook.update({ where: { id: book.id }, data: { balance: { increment: totalReceived } } });
      await tx.interbankLoan.update({
        where: { id: loan.id },
        data: { status: "SETTLED", settledAt: new Date(), interestReceived: interest },
      });
      await tx.treasuryTransaction.create({
        data: {
          amount: totalReceived,
          type: "CREDIT",
          description: `Interbank loan settled — ${counterparty?.name ?? "counterparty"} (principal ${Number(loan.principal).toFixed(2)} + interest ${interest.toFixed(2)})`,
          interbankLoanId: loan.id,
        },
      });
    });

    await writeAuditLog({
      action: "INTERBANK_LOAN_SETTLED",
      actorEmail: await actorEmail(req.userId),
      targetType: "InterbankLoan",
      targetId: loan.id,
      metadata: { principal: loan.principal.toString(), interest: interest.toString(), daysHeld: held },
    });

    res.json({ loan: { ...loan, status: "SETTLED", interestReceived: interest } });
  })
);

router.post(
  "/loans/:id/default",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const loan = await prisma.interbankLoan.findUnique({ where: { id: req.params.id } });
    if (!loan) {
      throw new NotFoundError("Loan not found");
    }
    if (loan.status !== "ACTIVE") {
      throw new BadRequestError("Only an active loan can be marked as defaulted");
    }

    // No cash comes back — the principal already lent out is a realized loss.
    // Nothing to book against TreasuryBook beyond what was already debited
    // when the loan was originated.
    const updated = await prisma.interbankLoan.update({
      where: { id: loan.id },
      data: { status: "DEFAULTED", defaultedAt: new Date() },
    });

    await writeAuditLog({
      action: "INTERBANK_LOAN_DEFAULTED",
      actorEmail: await actorEmail(req.userId),
      targetType: "InterbankLoan",
      targetId: loan.id,
      metadata: { principal: loan.principal.toString() },
    });

    res.json({ loan: updated });
  })
);

export default router;
