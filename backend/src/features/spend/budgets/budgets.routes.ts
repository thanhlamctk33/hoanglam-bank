import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/errorHandler";
import { ValidationError } from "../../../errors/AppError";
import { requireCompanyAdmin } from "../../../middleware/companyAdmin";
import * as budgetsService from "./budgets.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const budgets = await budgetsService.listBudgets(req.companyId);
    res.json({ budgets });
  })
);

router.get(
  "/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const budget = await budgetsService.getBudget(req.companyId, req.params.id);
    res.json({ budget });
  })
);

const createSchema = z.object({
  name: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().default("USD"),
  period: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]).default("MONTHLY"),
  startDate: z.coerce.date().optional(),
  ownerId: z.string().uuid().optional(),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = createSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const budget = await budgetsService.createBudget(req.companyId, req.userId, parsedBody.data);
    res.status(201).json({ budget });
  })
);

const updateSchema = z.object({
  amount: z.number().positive(),
});

router.patch(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = updateSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const budget = await budgetsService.updateBudgetAmount(req.companyId, req.params.id, parsedBody.data.amount, req.userId);
    res.json({ budget });
  })
);

const statusSchema = z.object({ status: z.enum(["ACTIVE", "FROZEN"]) });

router.patch(
  "/:id/status",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = statusSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const budget = await budgetsService.setBudgetStatus(req.companyId, req.params.id, parsedBody.data.status, req.userId);
    res.json({ budget });
  })
);

router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    await budgetsService.deleteBudget(req.companyId, req.params.id, req.userId);
    res.status(204).end();
  })
);

const resubmitSchema = z.object({
  name: z.string().min(1),
  amount: z.number().positive(),
});

router.patch(
  "/:id/resubmit",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = resubmitSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const budget = await budgetsService.resubmitBudget(req.companyId, req.params.id, parsedBody.data);
    res.json({ budget });
  })
);

export default router;
