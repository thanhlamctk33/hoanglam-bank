import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin, hasApprovalPower } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { BadGatewayError, NotFoundError, PaymentRequiredError, ServiceUnavailableError, ValidationError } from "../../errors/AppError";
import { extractReceiptFields, OCR_MIME_TYPES } from "./ocr.service";
import { checkLimit } from "../subscription/subscription.service";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { convertCurrency } from "../../shared/fx/fx.service";

async function actorEmail(userId: string | undefined): Promise<string> {
  const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  return user?.email ?? "unknown";
}

const router = Router();
router.use(requireAuth);

// Claims at or above this amount are flagged for admin attention. Configured
// per-company at Spend > Policies (falls back to 500 if no policy row exists yet).
// The limit is always set in USD, so claim amounts are converted to USD before comparing.
async function getClaimFlagLimit(companyId: string | undefined): Promise<number> {
  if (!companyId) return 500;
  const policy = await prisma.spendPolicy.findUnique({ where: { companyId } });
  return policy ? Number(policy.claimFlagLimit) : 500;
}

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const claims = await prisma.claim.findMany({
      where: { companyId: req.companyId },
      include: { submittedBy: { select: { id: true, name: true } } },
      orderBy: { submittedAt: "desc" },
    });
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

    const limitCheck = await checkLimit(req.companyId!, "claim");
    if (!limitCheck.allowed) {
      throw new PaymentRequiredError(limitCheck.message);
    }

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    const flagLimit = await getClaimFlagLimit(req.companyId);

    const amountInUsd = convertCurrency(parsed.data.amount, parsed.data.currency, "USD");

    const claim = await prisma.claim.create({
      data: {
        ...parsed.data,
        status: hasApprovalPower(actor) ? "APPROVED" : "PENDING",
        flagged: amountInUsd > flagLimit,
        companyId: req.companyId!,
        submittedById: req.userId!,
      },
    });

    await writeAuditLog({
      action: claim.status === "APPROVED" ? "CLAIM_SUBMITTED_AUTO_APPROVED" : "CLAIM_SUBMITTED",
      actorEmail: await actorEmail(req.userId),
      targetType: "Claim",
      targetId: claim.id,
      metadata: { title: claim.title, amount: claim.amount.toString() },
    });

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

    const limitCheck = await checkLimit(req.companyId!, "claim", parsed.data.claims.length);
    if (!limitCheck.allowed) {
      throw new PaymentRequiredError(limitCheck.message);
    }

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    const status = hasApprovalPower(actor) ? "APPROVED" : "PENDING";
    const batchId = randomUUID();
    const flagLimit = await getClaimFlagLimit(req.companyId);

    const claims = await prisma.$transaction(
      parsed.data.claims.map((c) =>
        prisma.claim.create({
          data: {
            ...c,
            status,
            flagged: convertCurrency(c.amount, c.currency, "USD") > flagLimit,
            batchId,
            companyId: req.companyId!,
            submittedById: req.userId!,
          },
        })
      )
    );

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

    if (!process.env.ANTHROPIC_API_KEY) {
      throw new ServiceUnavailableError("Receipt scanning is not configured. Set ANTHROPIC_API_KEY in backend/.env.");
    }

    try {
      const result = await extractReceiptFields(parsed.data.imageBase64, parsed.data.mimeType);
      res.json(result);
    } catch (err) {
      console.error("Receipt parse error:", err);
      throw new BadGatewayError("Failed to read the receipt.");
    }
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

    const claim = await prisma.claim.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
    });
    if (!claim) {
      throw new NotFoundError("Claim not found");
    }

    const updated = await prisma.claim.update({
      where: { id: claim.id },
      data: { status: parsed.data.status },
    });

    await writeAuditLog({
      action: `CLAIM_${parsed.data.status}`,
      actorEmail: await actorEmail(req.userId),
      targetType: "Claim",
      targetId: claim.id,
      metadata: { title: claim.title, amount: claim.amount.toString() },
    });

    res.json({ claim: updated });
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

    const result = await prisma.claim.updateMany({
      where: { batchId: req.params.batchId, companyId: req.companyId, status: "PENDING" },
      data: { status: parsed.data.status },
    });

    if (result.count > 0) {
      await writeAuditLog({
        action: `CLAIM_BATCH_${parsed.data.status}`,
        actorEmail: await actorEmail(req.userId),
        targetType: "Claim",
        targetId: req.params.batchId,
        metadata: { count: String(result.count) },
      });
    }

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

    const result = await prisma.claim.updateMany({
      where: { id: { in: parsed.data.ids }, companyId: req.companyId, status: "PENDING" },
      data: { status: parsed.data.status },
    });

    if (result.count > 0) {
      await writeAuditLog({
        action: `CLAIM_BULK_${parsed.data.status}`,
        actorEmail: await actorEmail(req.userId),
        targetType: "Claim",
        metadata: { count: String(result.count) },
      });
    }

    res.json({ ok: true });
  })
);

router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const claim = await prisma.claim.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!claim) {
      throw new NotFoundError("Claim not found");
    }

    await prisma.claim.delete({ where: { id: claim.id } });

    await writeAuditLog({
      action: "CLAIM_DELETED",
      actorEmail: await actorEmail(req.userId),
      targetType: "Claim",
      targetId: claim.id,
      metadata: { title: claim.title, amount: claim.amount.toString() },
    });

    res.status(204).end();
  })
);

export default router;
