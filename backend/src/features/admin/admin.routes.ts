import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireStaff } from "../../middleware/staff";
import { asyncHandler } from "../../middleware/errorHandler";
import { ValidationError } from "../../errors/AppError";
import * as adminService from "./admin.service";

const router = Router();
router.use(requireAuth, requireStaff);

router.get(
  "/customers",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    const customers = await adminService.listCustomers();
    res.json({ customers });
  })
);

const freezeSchema = z.object({ frozen: z.boolean() });

router.patch(
  "/accounts/:accountId/freeze",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = freezeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const account = await adminService.setAccountFrozen(req.params.accountId, parsed.data.frozen, req.userId);
    res.json({ account });
  })
);

router.get(
  "/transactions",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    const transactions = await adminService.listRecentTransactions();
    res.json({ transactions });
  })
);

router.get(
  "/claims",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
    // page/pageSize are opt-in — omitting them preserves the old "return
    // everything" behavior that the Approvals overview page relies on.
    const page = req.query.page ? Math.max(1, Number(req.query.page)) : undefined;
    const pageSize = req.query.pageSize ? Math.max(1, Math.min(100, Number(req.query.pageSize))) : undefined;

    const { claims, total } = await adminService.listClaims({ status, q, page, pageSize });
    res.json({ claims, total });
  })
);

const claimStatusSchema = z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED"]) });

router.patch(
  "/claims/:id/status",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = claimStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const claim = await adminService.updateClaimStatus(req.params.id, parsed.data.status, req.userId);
    res.json({ claim });
  })
);

router.delete(
  "/claims/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await adminService.deleteClaim(req.params.id, req.userId);
    res.status(204).end();
  })
);

router.get(
  "/audit-log",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    const entries = await adminService.listAuditLog();
    res.json({ entries });
  })
);

router.get(
  "/approval-requests",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const targetType = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const page = req.query.page ? Math.max(1, Number(req.query.page)) : undefined;
    const pageSize = req.query.pageSize ? Math.max(1, Math.min(100, Number(req.query.pageSize))) : undefined;

    const { requests, total } = await adminService.listApprovalRequests({ status, targetType, q, page, pageSize });
    res.json({ requests, total });
  })
);

router.patch(
  "/approval-requests/:id/approve",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await adminService.approveApprovalRequest(req.params.id, req.userId);
    res.json({ ok: true });
  })
);

const rejectSchema = z.object({ reason: z.string().min(1) });

router.patch(
  "/approval-requests/:id/reject",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    await adminService.rejectApprovalRequest(req.params.id, parsed.data.reason, req.userId);
    res.json({ ok: true });
  })
);

router.delete(
  "/approval-requests/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await adminService.deleteApprovalRequest(req.params.id, req.userId);
    res.status(204).end();
  })
);

router.get(
  "/kyb",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const companies = await adminService.listKybCompanies(status);
    res.json({ companies });
  })
);

router.get(
  "/kyb/:companyId",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const company = await adminService.getKybCompanyDetail(req.params.companyId);
    res.json({ company });
  })
);

router.patch(
  "/kyb/:companyId/approve",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await adminService.approveKyb(req.params.companyId, req.userId);
    res.json({ ok: true });
  })
);

const kybReasonSchema = z.object({ reason: z.string().min(1) });

router.patch(
  "/kyb/:companyId/reject",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = kybReasonSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    await adminService.rejectKyb(req.params.companyId, parsed.data.reason, req.userId);
    res.json({ ok: true });
  })
);

router.patch(
  "/kyb/:companyId/needs-info",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = kybReasonSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    await adminService.kybNeedsInfo(req.params.companyId, parsed.data.reason, req.userId);
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Credit Apply (maker-checker) — Operation dashboard controls the lending
// side of a company's account. One staff member (maker) submits a request,
// a *different* staff member (checker) approves or rejects it.
// ---------------------------------------------------------------------------

router.get(
  "/credit-applies",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const creditApplies = await adminService.listCreditApplies(status);
    res.json({ creditApplies });
  })
);

router.get(
  "/credit-applies/:id/risk-snapshot",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const snapshot = await adminService.getCreditApplyRiskSnapshot(req.params.id);
    res.json({ snapshot });
  })
);

const createCreditApplySchema = z.object({
  companyId: z.string().uuid(),
  requestedAmount: z.number().positive(),
  note: z.string().max(500).optional(),
});

router.post(
  "/credit-applies",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createCreditApplySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const creditApply = await adminService.createCreditApply(parsed.data, req.userId);
    res.status(201).json({ creditApply });
  })
);

const forwardCreditApplySchema = z.object({
  note: z.string().max(500).optional(),
});

router.patch(
  "/credit-applies/:id/forward",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = forwardCreditApplySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const creditApply = await adminService.forwardCreditApply(req.params.id, parsed.data.note, req.userId);
    res.json({ creditApply });
  })
);

const approveCreditApplySchema = z.object({
  approvedAmount: z.number().positive().optional(),
  interestRatePct: z.number().positive().max(100).optional(),
  termMonths: z.number().int().positive().max(360).optional(),
  note: z.string().max(500).optional(),
});

router.patch(
  "/credit-applies/:id/approve",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = approveCreditApplySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const creditApply = await adminService.approveCreditApply(req.params.id, parsed.data, req.userId);
    res.json({ creditApply });
  })
);

const rejectCreditApplySchema = z.object({ reason: z.string().min(1) });

router.patch(
  "/credit-applies/:id/reject",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = rejectCreditApplySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const creditApply = await adminService.rejectCreditApply(req.params.id, parsed.data.reason, req.userId);
    res.json({ creditApply });
  })
);

// ---------------------------------------------------------------------------
// Business detail — full "manage this company" view for Operation staff:
// profile, KYB, contract, credit line, and their cards/budgets/claims.
// ---------------------------------------------------------------------------

router.get(
  "/customers/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const detail = await adminService.getCustomerDetail(req.params.id);
    res.json(detail);
  })
);

export default router;
