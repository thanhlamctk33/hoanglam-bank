import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { KybStatus } from "../kyb/kyb.config";

const router = Router();
router.use(requireAuth);

const KYC_ID_TYPES = ["NATIONAL_ID", "PASSPORT"] as const;

// Individual identity verification (KYC) for the person completing signup —
// step 1 of the mandatory onboarding wizard, before KYB (business
// verification). Auto-approved on submit: this is a sandbox with no real
// document-verification vendor, and (unlike KYB) there's no staff review
// queue for KYC, so there's nothing to sit and wait on.
router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const profile = await prisma.kycProfile.findUnique({ where: { userId: req.userId! } });
    res.json({
      status: (profile?.status as KybStatus) ?? "NOT_STARTED",
      profile,
    });
  })
);

function assertEditable(status: KybStatus) {
  if (status === "APPROVED") {
    return "Your identity is already verified.";
  }
  return null;
}

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
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const existing = await prisma.kycProfile.findUnique({ where: { userId: req.userId! } });
    const blocked = assertEditable((existing?.status as KybStatus) ?? "NOT_STARTED");
    if (blocked) throw new UnprocessableEntityError(blocked);

    const profile = await prisma.kycProfile.upsert({
      where: { userId: req.userId! },
      create: { ...parsed.data, userId: req.userId! },
      update: parsed.data,
    });

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
    const parsed = documentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const existing = await prisma.kycProfile.findUnique({ where: { userId: req.userId! } });
    if (!existing) {
      throw new UnprocessableEntityError("Fill in your identity details before uploading an ID.");
    }
    const blocked = assertEditable(existing.status as KybStatus);
    if (blocked) throw new UnprocessableEntityError(blocked);

    const { fileBase64, mimeType } = parsed.data;
    const profile = await prisma.kycProfile.update({
      where: { userId: req.userId! },
      data: { idDocumentUrl: `data:${mimeType};base64,${fileBase64}` },
    });

    res.json({ profile });
  })
);

router.post(
  "/submit",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const profile = await prisma.kycProfile.findUnique({ where: { userId: req.userId! } });
    if (!profile) {
      throw new UnprocessableEntityError("Complete your identity details before submitting.");
    }
    if (profile.status === "APPROVED") {
      // Idempotent: submit may be retried (e.g. a later step in the onboarding
      // wizard failed and the person clicked Submit again) — treat an
      // already-approved profile as success rather than erroring out and
      // permanently stranding them on the review step.
      res.json({ profile });
      return;
    }
    if (!profile.idDocumentUrl) {
      throw new UnprocessableEntityError("Upload a photo of your ID before submitting.");
    }

    const now = new Date();
    const updated = await prisma.kycProfile.update({
      where: { userId: req.userId! },
      data: { status: "APPROVED", submittedAt: now, reviewedAt: now, rejectionReason: null },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "KYC_AUTO_APPROVED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "KycProfile",
      targetId: updated.id,
    });

    res.json({ profile: updated });
  })
);

export default router;
