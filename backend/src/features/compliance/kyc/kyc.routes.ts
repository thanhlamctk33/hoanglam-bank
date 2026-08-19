import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/errorHandler";
import { ValidationError } from "../../../errors/AppError";
import { KYC_ID_TYPES } from "./kyc.config";
import * as kycService from "./kyc.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    res.json(await kycService.getKycState(req.userId));
  })
);

const profileSchema = z.object({
  fullName: z.string().min(1),
  dateOfBirth: z.coerce.date(),
  nationality: z.string().min(1),
  idType: z.enum(KYC_ID_TYPES),
  idNumber: z.string().min(1),
});

router.put(
  "/profile",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = profileSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const profile = await kycService.saveKycProfile(req.userId, parsedBody.data);
    res.json({ profile });
  })
);

const documentSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  fileBase64: z.string().min(1),
});

router.put(
  "/document",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = documentSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const profile = await kycService.saveKycDocument(req.userId, parsedBody.data);
    res.json({ profile });
  })
);

router.post(
  "/submit",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const profile = await kycService.submitKyc(req.userId);
    res.json({ profile });
  })
);

export default router;
