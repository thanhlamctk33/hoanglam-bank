import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/errorHandler";
import { ValidationError } from "../../../errors/AppError";
import * as subscriptionService from "./subscription.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const overview = await subscriptionService.getSubscriptionOverview(req.companyId);
    res.json(overview);
  })
);

const changeSchema = z.object({
  tier: z.enum(["FREE", "PRO", "BUSINESS"]),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = changeSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const result = await subscriptionService.changeTier(req.companyId, parsedBody.data.tier, req.userId);
    res.json(result);
  })
);

router.post(
  "/reset",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const result = await subscriptionService.resetTier(req.companyId, req.userId);
    res.json(result);
  })
);

export default router;
