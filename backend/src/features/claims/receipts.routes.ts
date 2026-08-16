import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { extractReceiptFields, OCR_MIME_TYPES } from "./ocr.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const receipts = await prisma.receipt.findMany({
      where: { companyId: req.companyId },
      include: { uploadedBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
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
    const { imageBase64, filename, mimeType } = parsed.data;

    let extractedTitle: string | null = null;
    let extractedAmount: number | null = null;

    if (process.env.ANTHROPIC_API_KEY && (OCR_MIME_TYPES as readonly string[]).includes(mimeType)) {
      try {
        const result = await extractReceiptFields(imageBase64, mimeType as (typeof OCR_MIME_TYPES)[number]);
        extractedTitle = result.title;
        extractedAmount = result.amount;
      } catch (err) {
        console.error("Receipt library OCR error:", err);
      }
    }

    const receipt = await prisma.receipt.create({
      data: {
        url: `data:${mimeType};base64,${imageBase64}`,
        filename,
        mimeType,
        extractedTitle,
        extractedAmount,
        companyId: req.companyId!,
        uploadedById: req.userId!,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    res.status(201).json({ receipt });
  })
);

router.delete(
  "/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const receipt = await prisma.receipt.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
    });
    if (!receipt) {
      throw new NotFoundError("Receipt not found");
    }
    await prisma.receipt.delete({ where: { id: receipt.id } });
    res.status(204).end();
  })
);

export default router;
