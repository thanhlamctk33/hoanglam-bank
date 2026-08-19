import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { requireCompanyAdmin } from "../../../middleware/companyAdmin";
import { asyncHandler } from "../../../middleware/errorHandler";
import { ValidationError } from "../../../errors/AppError";
import * as spendPolicyService from "./spendPolicy.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const policy = await spendPolicyService.getOrCreatePolicy(req.companyId);
    res.json({ policy });
  })
);

const updateSchema = z.object({
  cardSpendLimitCap: z.number().positive().nullable(),
  budgetAmountCap: z.number().positive().nullable(),
  approvalThreshold: z.number().positive().nullable(),
  claimFlagLimit: z.number().positive(),
  // Velocity/fraud controls: velocityMaxCount null (or omitted) means no
  // limit — same "null = unlimited" convention as the other caps above.
  velocityMaxCount: z.number().int().positive().nullable().optional(),
  velocityWindowMinutes: z.number().int().positive().max(1440).optional(),
});

router.patch(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = updateSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const policy = await spendPolicyService.updatePolicy(req.companyId, req.userId, parsedBody.data);
    res.json({ policy });
  })
);

router.post(
  "/reset",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const policy = await spendPolicyService.resetPolicy(req.companyId, req.userId);
    res.json({ policy });
  })
);

export default router;
