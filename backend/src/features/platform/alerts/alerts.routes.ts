import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { requireCompanyAdmin } from "../../../middleware/companyAdmin";
import { asyncHandler } from "../../../middleware/errorHandler";
import { ValidationError } from "../../../errors/AppError";
import * as alertsService from "./alerts.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const rules = await alertsService.listRules(req.companyId);
    res.json({ rules });
  })
);

const createSchema = z.object({
  type: z.enum(["LOW_BALANCE", "LARGE_TRANSACTION"]),
  threshold: z.number().positive(),
  accountId: z.string().uuid().optional(),
});

router.post(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = createSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const rule = await alertsService.createRule(req.companyId, req.userId, parsedBody.data);
    res.status(201).json({ rule });
  })
);

const updateSchema = z.object({ active: z.boolean() });

router.patch(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = updateSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const rule = await alertsService.setRuleActive(req.companyId, req.params.id, parsedBody.data.active);
    res.json({ rule });
  })
);

router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    await alertsService.deleteRule(req.companyId, req.params.id);
    res.status(204).end();
  })
);

export default router;
