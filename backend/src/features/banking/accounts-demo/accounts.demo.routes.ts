import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { requireCompanyAdmin } from "../../../middleware/companyAdmin";
import { asyncHandler } from "../../../middleware/errorHandler";
import { NotFoundError, ValidationError } from "../../../errors/AppError";
import { isProduction } from "../../../config/env";
import * as demoService from "./accounts.demo.service";

/**
 * Sandbox-only account endpoints, split out of accounts.routes.ts so demo
 * data generation sits well away from the real money-movement routes.
 *
 * Every route here is disabled outside development/test: the guard below
 * answers 404 rather than 403 so a production deployment doesn't advertise
 * that these endpoints exist at all. They're mounted under the same
 * /api/accounts prefix, so the frontend's existing calls are unchanged.
 */
const router = Router();

router.use((_req, _res, next) => {
  if (isProduction) {
    return next(new NotFoundError("Not found"));
  }
  next();
});

router.use(requireAuth);

const demoDataSchema = z.object({
  months: z.number().int().min(1).max(24).default(6),
});

router.post(
  "/:id/generate-demo-data",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = demoDataSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const created = await demoService.generateDemoData(req.companyId, req.params.id, parsedBody.data.months, req.userId);
    res.json({ created });
  })
);

router.post(
  "/reset-demo",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    await demoService.resetDemoData(req.companyId, req.userId);
    res.json({ ok: true });
  })
);

export default router;
