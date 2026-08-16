import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { NotFoundError, UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { KYB_DOCUMENT_TYPES, KybStatus } from "./kyb.config";

const router = Router();
router.use(requireAuth);

async function loadState(companyId: string) {
  const [company, businessProfile, beneficialOwners, kybDocuments] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { kybStatus: true, kybSubmittedAt: true, kybReviewedAt: true, kybRejectionReason: true },
    }),
    prisma.businessProfile.findUnique({ where: { companyId } }),
    prisma.beneficialOwner.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
    prisma.kybDocument.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    status: (company?.kybStatus as KybStatus) ?? "NOT_STARTED",
    submittedAt: company?.kybSubmittedAt ?? null,
    reviewedAt: company?.kybReviewedAt ?? null,
    rejectionReason: company?.kybRejectionReason ?? null,
    businessProfile,
    beneficialOwners,
    kybDocuments,
  };
}

function assertEditable(status: KybStatus) {
  if (status === "PENDING_REVIEW") {
    return "Your verification is currently under review — you can't make changes until it's reviewed.";
  }
  if (status === "APPROVED") {
    return "Your business is already verified.";
  }
  return null;
}

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    res.json(await loadState(req.companyId!));
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
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const status = await prisma.company.findUnique({ where: { id: req.companyId }, select: { kybStatus: true } });
    const blocked = assertEditable((status?.kybStatus as KybStatus) ?? "NOT_STARTED");
    if (blocked) throw new UnprocessableEntityError(blocked);

    const { website, ...rest } = parsed.data;
    const profile = await prisma.businessProfile.upsert({
      where: { companyId: req.companyId! },
      create: { ...rest, website: website || null, companyId: req.companyId! },
      update: { ...rest, website: website || null },
    });

    res.json({ businessProfile: profile });
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
    const parsed = ownerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const status = await prisma.company.findUnique({ where: { id: req.companyId }, select: { kybStatus: true } });
    const blocked = assertEditable((status?.kybStatus as KybStatus) ?? "NOT_STARTED");
    if (blocked) throw new UnprocessableEntityError(blocked);

    const owner = await prisma.beneficialOwner.create({
      data: { ...parsed.data, companyId: req.companyId! },
    });
    res.status(201).json({ beneficialOwner: owner });
  })
);

router.delete(
  "/owners/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const owner = await prisma.beneficialOwner.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!owner) {
      throw new NotFoundError("Owner not found");
    }
    const status = await prisma.company.findUnique({ where: { id: req.companyId }, select: { kybStatus: true } });
    const blocked = assertEditable((status?.kybStatus as KybStatus) ?? "NOT_STARTED");
    if (blocked) throw new UnprocessableEntityError(blocked);

    await prisma.beneficialOwner.delete({ where: { id: owner.id } });
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
    const parsed = documentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const status = await prisma.company.findUnique({ where: { id: req.companyId }, select: { kybStatus: true } });
    const blocked = assertEditable((status?.kybStatus as KybStatus) ?? "NOT_STARTED");
    if (blocked) throw new UnprocessableEntityError(blocked);

    const { fileBase64, mimeType, filename, type } = parsed.data;
    const document = await prisma.kybDocument.create({
      data: {
        type,
        filename,
        mimeType,
        url: `data:${mimeType};base64,${fileBase64}`,
        companyId: req.companyId!,
      },
    });
    res.status(201).json({ kybDocument: document });
  })
);

router.delete(
  "/documents/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const document = await prisma.kybDocument.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!document) {
      throw new NotFoundError("Document not found");
    }
    const status = await prisma.company.findUnique({ where: { id: req.companyId }, select: { kybStatus: true } });
    const blocked = assertEditable((status?.kybStatus as KybStatus) ?? "NOT_STARTED");
    if (blocked) throw new UnprocessableEntityError(blocked);

    await prisma.kybDocument.delete({ where: { id: document.id } });
    res.status(204).end();
  })
);

router.post(
  "/submit",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const state = await loadState(req.companyId!);

    if (state.status === "PENDING_REVIEW") {
      throw new UnprocessableEntityError("Your verification is already under review.");
    }
    if (state.status === "APPROVED") {
      // Idempotent: submit may be retried (e.g. the person double-clicked, or
      // an earlier attempt succeeded here but failed on a later step) — treat
      // an already-approved company as success rather than erroring out and
      // permanently stranding them on the review step.
      res.json(state);
      return;
    }
    if (!state.businessProfile) {
      throw new UnprocessableEntityError("Complete your business profile before submitting.");
    }
    if (state.beneficialOwners.length === 0) {
      throw new UnprocessableEntityError("Add at least one beneficial owner before submitting.");
    }
    const hasRegistrationDoc = state.kybDocuments.some((d: { type: string }) => d.type === "BUSINESS_REGISTRATION");
    if (!hasRegistrationDoc) {
      throw new UnprocessableEntityError("Upload your business registration document before submitting.");
    }

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    const now = new Date();
    // Auto-approved on submit: this is a sandbox with no real underwriting
    // team, and gating the onboarding wizard (register → KYC → KYB → main
    // dashboard) on a human bank-staff review would strand every new signup
    // in PENDING_REVIEW indefinitely. The staff KYB queue at
    // /dashboard/kyb and its approve/reject/needs-info actions still work as
    // before for any company that ends up in PENDING_REVIEW some other way.
    await prisma.company.update({
      where: { id: req.companyId },
      data: {
        kybStatus: "APPROVED",
        kybSubmittedAt: now,
        kybReviewedAt: now,
        kybRejectionReason: null,
      },
    });

    await writeAuditLog({
      action: "KYB_AUTO_APPROVED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Company",
      targetId: req.companyId!,
    });

    res.json(await loadState(req.companyId!));
  })
);

// Testing/demo convenience: wipes this company's business profile,
// beneficial owners, and uploaded documents, and resets kybStatus back to
// NOT_STARTED, so the verification wizard can be tried again from scratch.
// Doesn't touch the lending contract or any credit line — those have their
// own "Complete KYB before you can..." checks, so leaving them as-is just
// means re-verifying will unblock them again rather than resetting them too.
router.post(
  "/reset-demo",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const companyId = req.companyId!;

    await prisma.kybDocument.deleteMany({ where: { companyId } });
    await prisma.beneficialOwner.deleteMany({ where: { companyId } });
    await prisma.businessProfile.deleteMany({ where: { companyId } });
    await prisma.company.update({
      where: { id: companyId },
      data: {
        kybStatus: "NOT_STARTED",
        kybSubmittedAt: null,
        kybReviewedAt: null,
        kybRejectionReason: null,
      },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "KYB_DEMO_RESET",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Company",
      targetId: companyId,
    });

    res.json(await loadState(companyId));
  })
);

export default router;
