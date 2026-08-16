import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { isProduction } from "../../config/env";
import { MAX_GRACE_MONTHS } from "../credit/lending.config";
import { FX_CURRENCIES } from "../../shared/fx/fx.service";
import * as drawdownService from "./drawdown.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const drawdowns = await drawdownService.listDrawdowns(req.companyId);
    res.json({ drawdowns });
  })
);

router.get(
  "/:id/installments",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const installments = await drawdownService.listInstallments(req.companyId, req.params.id);
    res.json({ installments });
  })
);

// Conditions precedent checklist — shown to the customer before they draw
// down, and enforced again server-side in POST / below.
router.get(
  "/conditions",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const result = await drawdownService.getConditions(req.companyId);
    res.json(result);
  })
);

const createSchema = z.object({
  amount: z.number().positive(),
  purpose: z.string().max(200).optional(),
  termsAccepted: z.literal(true, {
    errorMap: () => ({ message: "You must confirm the lending terms to draw down funds." }),
  }),
  accountId: z.string().uuid().optional(),
  // Which currency to disburse into. Ignored if accountId is given. If the
  // company doesn't yet have an unfrozen account in this currency, one is
  // opened automatically so a drawdown can land in any supported currency.
  currency: z.enum(FX_CURRENCIES).optional(),
  repaymentMethod: z.enum(["REVOLVING", "AMORTIZING", "INTEREST_ONLY", "BALLOON"]).default("REVOLVING"),
  graceMonths: z.number().int().min(0).max(MAX_GRACE_MONTHS).default(0),
  autoDeduct: z.boolean().default(false),
  autoDeductAccountId: z.string().uuid().optional(),
});

router.post(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const drawdown = await drawdownService.createDrawdown(req.companyId, req.userId, parsed.data);
    res.status(201).json({ drawdown });
  })
);

// Sandbox-only, same guard as the other demo endpoints: 404 outside
// development rather than 403, so production doesn't advertise it exists.
router.post(
  "/reset-demo",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    if (isProduction) {
      throw new NotFoundError("Not found");
    }

    await drawdownService.resetDemoData(req.companyId, req.userId);
    res.json({ ok: true });
  })
);

export default router;
