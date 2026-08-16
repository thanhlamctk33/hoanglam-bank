import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { isProduction } from "../../config/env";
import * as repaymentService from "./repayment.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const repayments = await repaymentService.listRepayments(req.companyId);
    res.json({ repayments });
  })
);

const createSchema = z.object({
  amount: z.number().positive(),
  accountId: z.string().uuid().optional(),
  // Which loan this repayment targets. Omitted (or a REVOLVING drawdown)
  // pays down the pooled outstanding balance directly, same as the
  // original behavior. A scheduled drawdown (AMORTIZING/INTEREST_ONLY/
  // BALLOON) instead applies the payment to its installments waterfall-
  // style — fee, then interest, then principal, oldest due date first.
  drawdownId: z.string().uuid().optional(),
});

router.post(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const repayment = await repaymentService.makeRepayment(req.companyId, req.userId, parsed.data);
    res.status(201).json({ repayment });
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

    await repaymentService.resetDemoData(req.companyId, req.userId);
    res.json({ ok: true });
  })
);

export default router;
