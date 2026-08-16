import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { isProduction } from "../../config/env";
import { INTERBANK_TERM_OPTIONS } from "./interbank.config";
import * as interbankService from "./interbank.service";
import { seedDemoTreasury } from "./interbank.demo.service";

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

router.get(
  "/term-options",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    res.json({ termOptions: INTERBANK_TERM_OPTIONS });
  })
);

// Sandbox-only, same guard as the account demo routes: 404 outside
// development rather than 403, so production doesn't advertise it exists.
router.post(
  "/seed-demo",
  asyncHandler<AuthedRequest>(async (req, res) => {
    if (isProduction) {
      throw new NotFoundError("Not found");
    }

    const result = await seedDemoTreasury(req.userId);
    if (!result.seeded) {
      return res.json({ ok: true, seeded: false, message: result.message });
    }
    res.json({ ok: true, seeded: true });
  })
);

// --- Counterparty banks ---

router.get(
  "/counterparties",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    const counterparties = await interbankService.listCounterparties();
    res.json({ counterparties });
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

    const counterparty = await interbankService.createCounterparty(parsed.data, req.userId);
    res.status(201).json({ counterparty });
  })
);

// --- Treasury book ---

router.get(
  "/treasury",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    const snapshot = await interbankService.getTreasurySnapshot();
    res.json(snapshot);
  })
);

// --- Interbank loans ---

router.get(
  "/loans",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    const loans = await interbankService.listLoans(statusFilter);
    res.json({ loans });
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

    const loan = await interbankService.bookLoan(parsed.data, req.userId);
    res.status(201).json({ loan });
  })
);

router.post(
  "/loans/:id/settle",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const loan = await interbankService.settleLoan(req.params.id, req.userId);
    res.json({ loan });
  })
);

router.post(
  "/loans/:id/default",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const loan = await interbankService.markLoanDefaulted(req.params.id, req.userId);
    res.json({ loan });
  })
);

export default router;
