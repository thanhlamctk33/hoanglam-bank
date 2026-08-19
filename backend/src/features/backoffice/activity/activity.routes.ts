import { Router } from "express";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { requireCompanyAdmin } from "../../../middleware/companyAdmin";
import { asyncHandler } from "../../../middleware/errorHandler";
import * as activityService from "./activity.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const take = Math.min(Math.max(Number(req.query.take) || 100, 1), 200);
    const entries = await activityService.listActivity(req.companyId, take);
    res.json({ entries });
  })
);

export default router;
