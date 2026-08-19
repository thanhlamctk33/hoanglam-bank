import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { requireCompanyAdmin } from "../../../middleware/companyAdmin";
import { asyncHandler } from "../../../middleware/errorHandler";
import { NotFoundError, ValidationError } from "../../../errors/AppError";
import { isProduction } from "../../../config/env";
import * as creditService from "./credit.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const overview = await creditService.getCreditOverview(req.companyId);
    res.json(overview);
  })
);

const applySchema = z.object({
  requestedAmount: z.number().positive(),
  purpose: z.string().max(500).optional(),
});

router.post(
  "/apply",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = applySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const creditApply = await creditService.applyForCredit(req.companyId, req.userId, parsedBody.data);
    res.status(201).json({ creditApply });
  })
);

router.post(
  "/accept-contract",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const contractAcceptedAt = await creditService.acceptLendingContract(req.companyId, req.userId);
    res.json({ contractAcceptedAt });
  })
);

// --- Demo-only endpoints ---------------------------------------------------
// Sandbox-only, same guard as the other demo endpoints: 404 outside
// development rather than 403, so production doesn't advertise it exists.

router.post(
  "/reset-demo",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    if (isProduction) {
      throw new NotFoundError("Not found");
    }

    await creditService.resetDemoData(req.companyId, req.userId);
    res.json({ ok: true });
  })
);

router.post(
  "/auto-approve-demo",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    if (isProduction) {
      throw new NotFoundError("Not found");
    }

    const creditApply = await creditService.autoApproveForDemo(req.companyId, req.userId);
    res.json({ creditApply });
  })
);

export default router;
