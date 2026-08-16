import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { ValidationError } from "../../errors/AppError";
import * as billsService from "./bills.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const bills = await billsService.listBills(req.companyId);
    res.json({ bills });
  })
);

const autopaySchema = z.object({
  accountId: z.string().uuid().nullable(),
});

router.patch(
  "/:id/autopay",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = autopaySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const bill = await billsService.setAutopayAccount(req.companyId, req.params.id, parsed.data.accountId, req.userId);
    res.json({ bill });
  })
);

const createSchema = z.object({
  vendor: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().default("USD"),
  dueDate: z.string().datetime(),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const bill = await billsService.createBill(req.companyId, parsed.data);
    res.status(201).json({ bill });
  })
);

const statusSchema = z.object({
  status: z.enum(["UNPAID", "PAID", "OVERDUE"]),
  accountId: z.string().uuid().optional(),
});

router.patch(
  "/:id/status",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const bill = await billsService.setBillStatus(
      req.companyId,
      req.params.id,
      parsed.data.status,
      parsed.data.accountId,
      req.userId
    );
    res.json({ bill });
  })
);

router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    await billsService.deleteBill(req.companyId, req.params.id);
    res.status(204).end();
  })
);

export default router;
