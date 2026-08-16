import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { ValidationError } from "../../errors/AppError";
import * as approvalService from "./approval.service";

const router = Router();
router.use(requireAuth);

// Pending approval requests for the caller's own company only — this is the
// self-service counterpart to /api/admin/approval-requests (which is bank-staff,
// cross-company). Company admins use this to approve their own team's requests
// without needing bank staff involvement.
router.get(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const targetType = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const requests = await approvalService.listPendingRequests(req.companyId, targetType);
    res.json({ requests });
  })
);

router.patch(
  "/:id/approve",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    await approvalService.approveRequest(req.companyId, req.params.id, req.userId);
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

    await approvalService.rejectRequest(req.companyId, req.params.id, parsed.data.reason, req.userId);
    res.json({ ok: true });
  })
);

export default router;
