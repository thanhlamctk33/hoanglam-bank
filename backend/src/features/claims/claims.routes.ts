import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { ValidationError } from "../../errors/AppError";
import { OCR_MIME_TYPES } from "./ocr.service";
import * as claimsService from "./claims.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const claims = await claimsService.listClaims(req.companyId);
    res.json({ claims });
  })
);

const createSchema = z.object({
  title: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().default("USD"),
  category: z.string().optional(),
  description: z.string().optional(),
  receiptUrl: z.string().url(),
  additionalReceiptUrls: z.array(z.string().url()).max(10).optional(),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const claim = await claimsService.createClaim(req.companyId, req.userId, parsed.data);
    res.status(201).json({ claim });
  })
);

const bulkCreateSchema = z.object({
  claims: z
    .array(
      z.object({
        title: z.string().min(1),
        amount: z.number().positive(),
        currency: z.string().default("USD"),
        category: z.string().optional(),
        description: z.string().optional(),
        receiptUrl: z.string().url(),
      })
    )
    .min(1)
    .max(20),
});

router.post(
  "/bulk",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = bulkCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const { claims, batchId } = await claimsService.createClaimsBulk(req.companyId, req.userId, parsed.data.claims);
    res.status(201).json({ claims, batchId });
  })
);

const parseReceiptSchema = z.object({
  imageBase64: z.string().min(1),
  mimeType: z.enum(OCR_MIME_TYPES),
});

router.post(
  "/parse-receipt",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = parseReceiptSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const result = await claimsService.parseReceipt(parsed.data.imageBase64, parsed.data.mimeType);
    res.json(result);
  })
);

const statusSchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
});

router.patch(
  "/:id/status",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const claim = await claimsService.setClaimStatus(req.companyId, req.params.id, parsed.data.status, req.userId);
    res.json({ claim });
  })
);

router.patch(
  "/batch/:batchId/status",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    await claimsService.setBatchStatus(req.companyId, req.params.batchId, parsed.data.status, req.userId);
    res.json({ ok: true });
  })
);

const bulkStatusSchema = z.object({
  ids: z.array(z.string()).min(1).max(100),
  status: z.enum(["APPROVED", "REJECTED"]),
});

router.patch(
  "/bulk-status",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = bulkStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    await claimsService.setBulkStatus(req.companyId, parsed.data.ids, parsed.data.status, req.userId);
    res.json({ ok: true });
  })
);

router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    await claimsService.deleteClaim(req.companyId, req.params.id, req.userId);
    res.status(204).end();
  })
);

export default router;
