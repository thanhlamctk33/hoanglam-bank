import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { ValidationError } from "../../errors/AppError";
import { FX_CURRENCIES } from "../../shared/fx/fx.service";
import { MAX_OVERDRAFT_LIMIT } from "../../shared/overdraft/overdraft.config";
import * as accountsService from "./accounts.service";

const router = Router();
router.use(requireAuth);

function parseQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const accounts = await accountsService.listAccounts(req.companyId);
    res.json({ accounts });
  })
);

const createAccountSchema = z.object({
  name: z.string().min(1).max(60),
  currency: z.enum(FX_CURRENCIES),
  type: z.enum(["CHECKING", "SAVINGS", "MONEY_MARKET"]).default("CHECKING"),
});

router.post(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const account = await accountsService.createAccount(req.companyId, req.userId, parsed.data);
    res.status(201).json({ account });
  })
);

const depositSchema = z.object({
  amount: z.number().positive().max(1_000_000),
});

router.post(
  "/:id/deposit",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = depositSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const account = await accountsService.depositFunds(req.companyId, req.params.id, parsed.data.amount, req.userId);
    res.json({ account });
  })
);

const overdraftSchema = z.object({
  overdraftLimit: z.number().min(0).max(MAX_OVERDRAFT_LIMIT),
});

router.patch(
  "/:id/overdraft",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = overdraftSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const account = await accountsService.setOverdraftLimit(
      req.companyId,
      req.params.id,
      parsed.data.overdraftLimit,
      req.userId
    );
    res.json({ account });
  })
);

router.get(
  "/:id/statement",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const statement = await accountsService.getStatement(req.companyId, req.params.id, parseQueryString(req.query.month));
    res.json(statement);
  })
);

router.get(
  "/reports",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
    const reports = await accountsService.getReports(req.companyId, months, parseQueryString(req.query.accountId));
    res.json(reports);
  })
);

router.get(
  "/:id/transactions",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const take = Math.min(Math.max(Number(req.query.take) || 25, 1), 200);
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    const typeParam = req.query.type;
    const type = typeParam === "DEBIT" || typeParam === "CREDIT" ? typeParam : undefined;

    const result = await accountsService.listTransactions(req.companyId, req.params.id, {
      take,
      skip,
      type,
      category: parseQueryString(req.query.category),
      from: parseQueryString(req.query.from),
      to: parseQueryString(req.query.to),
    });
    res.json(result);
  })
);

router.get(
  "/:id/transaction-categories",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const categories = await accountsService.listTransactionCategories(req.companyId, req.params.id);
    res.json({ categories });
  })
);

export default router;
