import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { ValidationError } from "../../errors/AppError";
import * as payeesService from "./payees.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const payees = await payeesService.listPayees(req.companyId);
    res.json({ payees });
  })
);

const createSchema = z.object({
  nickname: z.string().min(1).max(60),
  accountNumber: z.string().min(1).max(60),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const payee = await payeesService.createPayee(req.companyId, req.userId, parsed.data);
    res.status(201).json({ payee });
  })
);

router.delete(
  "/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await payeesService.deletePayee(req.companyId, req.params.id);
    res.status(204).end();
  })
);

export default router;
