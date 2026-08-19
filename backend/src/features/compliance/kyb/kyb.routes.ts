import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { requireCompanyAdmin } from "../../../middleware/companyAdmin";
import { asyncHandler } from "../../../middleware/errorHandler";
import { NotFoundError, ValidationError } from "../../../errors/AppError";
import { isProduction } from "../../../config/env";
import { KYB_DOCUMENT_TYPES } from "./kyb.config";
import * as kybService from "./kyb.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    res.json(await kybService.loadKybState(req.companyId));
  })
);

const profileSchema = z.object({
  legalName: z.string().min(1),
  registrationNumber: z.string().min(1),
  taxCode: z.string().min(1),
  incorporationDate: z.coerce.date(),
  businessType: z.string().min(1),
  industry: z.string().min(1),
  registeredAddress: z.string().min(1),
  website: z.string().url().optional().or(z.literal("")),
  expectedMonthlyVolume: z.number().nonnegative().default(0),
});

router.put(
  "/profile",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = profileSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const businessProfile = await kybService.saveBusinessProfile(req.companyId, parsedBody.data);
    res.json({ businessProfile });
  })
);

const ownerSchema = z.object({
  fullName: z.string().min(1),
  dateOfBirth: z.coerce.date(),
  nationality: z.string().min(1),
  ownershipPct: z.number().min(0).max(100),
  role: z.string().min(1),
  idNumber: z.string().min(1),
});

router.post(
  "/owners",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = ownerSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const beneficialOwner = await kybService.addBeneficialOwner(req.companyId, parsedBody.data);
    res.status(201).json({ beneficialOwner });
  })
);

router.delete(
  "/owners/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await kybService.removeBeneficialOwner(req.companyId, req.params.id);
    res.status(204).end();
  })
);

const documentSchema = z.object({
  type: z.enum(KYB_DOCUMENT_TYPES),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  fileBase64: z.string().min(1),
});

router.post(
  "/documents",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = documentSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const kybDocument = await kybService.addKybDocument(req.companyId, parsedBody.data);
    res.status(201).json({ kybDocument });
  })
);

router.delete(
  "/documents/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await kybService.removeKybDocument(req.companyId, req.params.id);
    res.status(204).end();
  })
);

router.post(
  "/submit",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const state = await kybService.submitKyb(req.companyId, req.userId);
    res.json(state);
  })
);

// Sandbox-only, same guard as the other demo endpoints: 404 outside
// development rather than 403, so production doesn't advertise it exists.
router.post(
  "/reset-demo",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    if (isProduction) {
      throw new NotFoundError("Not found");
    }

    const state = await kybService.resetDemoData(req.companyId, req.userId);
    res.json(state);
  })
);

export default router;
