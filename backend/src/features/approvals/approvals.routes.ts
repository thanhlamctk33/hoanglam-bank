import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { NotFoundError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";

const router = Router();
router.use(requireAuth);

async function actorEmail(userId: string | undefined): Promise<string> {
  const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  return user?.email ?? "unknown";
}

// Pending approval requests for the caller's own company only — this is the
// self-service counterpart to /api/admin/approval-requests (which is bank-staff,
// cross-company). Company admins use this to approve their own team's requests
// without needing bank staff involvement.
router.get(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const targetType = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const requests = await prisma.approvalRequest.findMany({
      where: {
        companyId: req.companyId,
        status: "PENDING",
        ...(targetType ? { targetType: targetType as "CARD" | "BUDGET" } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    const requesterIds = Array.from(new Set(requests.map((r) => r.requesterId)));
    const requesters = await prisma.user.findMany({
      where: { id: { in: requesterIds } },
      select: { id: true, name: true, email: true },
    });
    const requesterMap = new Map(requesters.map((u) => [u.id, u]));

    res.json({
      requests: requests.map((r) => ({
        id: r.id,
        targetType: r.targetType,
        targetId: r.targetId,
        reason: r.reason,
        metadata: r.metadata ? JSON.parse(r.metadata) : {},
        createdAt: r.createdAt,
        requester: requesterMap.get(r.requesterId) ?? null,
      })),
    });
  })
);

router.patch(
  "/:id/approve",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const request = await prisma.approvalRequest.findFirst({
      where: { id: req.params.id, companyId: req.companyId, status: "PENDING" },
    });
    if (!request) {
      throw new NotFoundError("Request not found");
    }

    await prisma.approvalRequest.update({
      where: { id: request.id },
      data: { status: "APPROVED", reviewerId: req.userId, reviewedAt: new Date() },
    });

    if (request.targetType === "CARD") {
      await prisma.card.update({ where: { id: request.targetId }, data: { status: "ACTIVE" } });
    } else {
      await prisma.budget.update({ where: { id: request.targetId }, data: { status: "ACTIVE" } });
    }

    await writeAuditLog({
      action: `${request.targetType}_APPROVED`,
      actorEmail: await actorEmail(req.userId),
      targetType: request.targetType === "CARD" ? "Card" : "Budget",
      targetId: request.targetId,
    });

    res.json({ ok: true });
  })
);

const rejectSchema = z.object({ reason: z.string().min(1) });

router.patch(
  "/:id/reject",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const request = await prisma.approvalRequest.findFirst({
      where: { id: req.params.id, companyId: req.companyId, status: "PENDING" },
    });
    if (!request) {
      throw new NotFoundError("Request not found");
    }

    await prisma.approvalRequest.update({
      where: { id: request.id },
      data: { status: "REJECTED", reason: parsed.data.reason, reviewerId: req.userId, reviewedAt: new Date() },
    });

    if (request.targetType === "CARD") {
      await prisma.card.update({
        where: { id: request.targetId },
        data: { status: "REJECTED", rejectionReason: parsed.data.reason },
      });
    } else {
      await prisma.budget.update({
        where: { id: request.targetId },
        data: { status: "REJECTED", rejectionReason: parsed.data.reason },
      });
    }

    await writeAuditLog({
      action: `${request.targetType}_REJECTED`,
      actorEmail: await actorEmail(req.userId),
      targetType: request.targetType === "CARD" ? "Card" : "Budget",
      targetId: request.targetId,
      metadata: { reason: parsed.data.reason },
    });

    res.json({ ok: true });
  })
);

export default router;
