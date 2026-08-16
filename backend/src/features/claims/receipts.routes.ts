import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { ValidationError } from "../../errors/AppError";
import * as receiptsService from "./receipts.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const receipts = await receiptsService.listReceipts(req.companyId);
    res.json({ receipts });
  })
);

const uploadSchema = z.object({
  imageBase64: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const receipt = await receiptsService.uploadReceipt(req.companyId, req.userId, parsed.data);
    res.status(201).json({ receipt });
  })
);

router.delete(
  "/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await receiptsService.deleteReceipt(req.companyId, req.params.id);
    res.status(204).end();
  })
);

export default router;
