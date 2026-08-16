import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireStaff } from "../../middleware/staff";
import { asyncHandler } from "../../middleware/errorHandler";
import { ForbiddenError, NotFoundError, UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { getActiveCreditApply, availableAmount, getCreditRiskSnapshot, getCreditMonitoring } from "../credit/credit.service";
import { MIN_CREDIT_APPLY_AMOUNT, DEFAULT_INTEREST_RATE_PCT, DEFAULT_TERM_MONTHS } from "../credit/lending.config";

const router = Router();
router.use(requireAuth, requireStaff);

async function actorEmail(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user?.email ?? "unknown";
}

router.get(
  "/customers",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    const companies = await prisma.company.findMany({
      where: { users: { none: { isStaff: true } } },
      include: {
        users: { select: { id: true, name: true, email: true, role: true } },
        accounts: true,
      },
      orderBy: { createdAt: "asc" },
    });
    res.json({ customers: companies });
  })
);

router.patch(
  "/accounts/:accountId/freeze",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const schema = z.object({ frozen: z.boolean() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const account = await prisma.account.findUnique({ where: { id: req.params.accountId } });
    if (!account) {
      throw new NotFoundError("Account not found");
    }

    const updated = await prisma.account.update({
      where: { id: account.id },
      data: { frozen: parsed.data.frozen },
    });

    await writeAuditLog({
      action: parsed.data.frozen ? "ACCOUNT_FROZEN" : "ACCOUNT_UNFROZEN",
      actorEmail: await actorEmail(req.userId!),
      targetType: "Account",
      targetId: account.id,
      metadata: { accountNumber: account.accountNumber },
    });

    res.json({ account: updated });
  })
);

router.get(
  "/transactions",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    const transactions = await prisma.transaction.findMany({
      include: { account: { include: { company: { select: { id: true, name: true } } } } },
      orderBy: { date: "desc" },
      take: 200,
    });
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

    const where = {
      ...(status ? { status: status as "PENDING" | "APPROVED" | "REJECTED" } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" as const } },
              { company: { name: { contains: q, mode: "insensitive" as const } } },
              { submittedBy: { name: { contains: q, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    };

    const total = await prisma.claim.count({ where });
    const claims = await prisma.claim.findMany({
      where,
      include: {
        company: { select: { id: true, name: true } },
        submittedBy: { select: { id: true, name: true } },
      },
      orderBy: { submittedAt: "desc" },
      ...(page && pageSize ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
    });
    res.json({ claims, total });
  })
);

router.patch(
  "/claims/:id/status",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const schema = z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED"]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const claim = await prisma.claim.findUnique({ where: { id: req.params.id } });
    if (!claim) {
      throw new NotFoundError("Claim not found");
    }

    const updated = await prisma.claim.update({
      where: { id: claim.id },
      data: { status: parsed.data.status },
    });

    await writeAuditLog({
      action: `CLAIM_${parsed.data.status}`,
      actorEmail: await actorEmail(req.userId!),
      targetType: "Claim",
      targetId: claim.id,
      metadata: { title: claim.title, amount: claim.amount.toString() },
    });

    res.json({ claim: updated });
  })
);

router.delete(
  "/claims/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const claim = await prisma.claim.findUnique({ where: { id: req.params.id } });
    if (!claim) {
      throw new NotFoundError("Claim not found");
    }

    await prisma.claim.delete({ where: { id: claim.id } });

    await writeAuditLog({
      action: "CLAIM_DELETED",
      actorEmail: await actorEmail(req.userId!),
      targetType: "Claim",
      targetId: claim.id,
      metadata: { title: claim.title, amount: claim.amount.toString() },
    });

    res.status(204).end();
  })
);

router.get(
  "/audit-log",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    const entries = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ entries });
  })
);

router.get(
  "/approval-requests",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const targetType = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const requests = await prisma.approvalRequest.findMany({
      where: {
        ...(status ? { status: status as "PENDING" | "APPROVED" | "REJECTED" } : {}),
        ...(targetType ? { targetType: targetType as "CARD" | "BUDGET" } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    const userIds = Array.from(
      new Set(requests.flatMap((r) => [r.requesterId, r.reviewerId]).filter((id): id is string => !!id))
    );
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    const companyIds = Array.from(new Set(requests.map((r) => r.companyId)));
    const companies = await prisma.company.findMany({
      where: { id: { in: companyIds } },
      select: { id: true, name: true },
    });
    const companyMap = new Map(companies.map((c) => [c.id, c]));

    const enriched = requests.map((r) => ({
      id: r.id,
      targetType: r.targetType,
      targetId: r.targetId,
      status: r.status,
      reason: r.reason,
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
      company: companyMap.get(r.companyId) ?? null,
      requester: userMap.get(r.requesterId) ?? null,
      reviewer: r.reviewerId ? userMap.get(r.reviewerId) ?? null : null,
    }));

    // ApprovalRequest has no Prisma relations (company/requester are plain id
    // columns, joined manually above), so text search and pagination happen
    // here in JS rather than in the query — fine at this table's scale.
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const filtered = q
      ? enriched.filter((r) => {
          const meta = Object.values(r.metadata).filter(Boolean).join(" ");
          return [meta, r.company?.name, r.requester?.name, r.requester?.email]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(q);
        })
      : enriched;

    const page = req.query.page ? Math.max(1, Number(req.query.page)) : undefined;
    const pageSize = req.query.pageSize ? Math.max(1, Math.min(100, Number(req.query.pageSize))) : undefined;
    const total = filtered.length;
    const paged =
      page && pageSize ? filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize) : filtered;

    res.json({ requests: paged, total });
  })
);

router.patch(
  "/approval-requests/:id/approve",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } });
    if (!request) {
      throw new NotFoundError("Request not found");
    }
    if (request.status !== "PENDING") {
      throw new UnprocessableEntityError("This request has already been reviewed");
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
      actorEmail: await actorEmail(req.userId!),
      targetType: request.targetType === "CARD" ? "Card" : "Budget",
      targetId: request.targetId,
    });

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

    const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } });
    if (!request) {
      throw new NotFoundError("Request not found");
    }
    if (request.status !== "PENDING") {
      throw new UnprocessableEntityError("This request has already been reviewed");
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
      actorEmail: await actorEmail(req.userId!),
      targetType: request.targetType === "CARD" ? "Card" : "Budget",
      targetId: request.targetId,
      metadata: { reason: parsed.data.reason },
    });

    res.json({ ok: true });
  })
);

router.delete(
  "/approval-requests/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } });
    if (!request) {
      throw new NotFoundError("Request not found");
    }

    await prisma.approvalRequest.delete({ where: { id: request.id } });

    if (request.targetType === "CARD") {
      await prisma.card.deleteMany({ where: { id: request.targetId } });
    } else {
      await prisma.budget.deleteMany({ where: { id: request.targetId } });
    }

    await writeAuditLog({
      action: `${request.targetType}_REQUEST_DELETED`,
      actorEmail: await actorEmail(req.userId!),
      targetType: request.targetType === "CARD" ? "Card" : "Budget",
      targetId: request.targetId,
    });

    res.status(204).end();
  })
);

router.get(
  "/kyb",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const companies = await prisma.company.findMany({
      where: {
        users: { none: { isStaff: true } },
        ...(status ? { kybStatus: status as "NOT_STARTED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "NEEDS_INFO" } : {}),
      },
      select: {
        id: true,
        name: true,
        kybStatus: true,
        kybSubmittedAt: true,
        kybReviewedAt: true,
        kybRejectionReason: true,
        businessProfile: true,
        _count: { select: { beneficialOwners: true, kybDocuments: true } },
      },
      orderBy: { kybSubmittedAt: "desc" },
    });
    res.json({ companies });
  })
);

router.get(
  "/kyb/:companyId",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const company = await prisma.company.findUnique({
      where: { id: req.params.companyId },
      select: {
        id: true,
        name: true,
        kybStatus: true,
        kybSubmittedAt: true,
        kybReviewedAt: true,
        kybRejectionReason: true,
        businessProfile: true,
        beneficialOwners: { orderBy: { createdAt: "asc" } },
        kybDocuments: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!company) {
      throw new NotFoundError("Company not found");
    }
    res.json({ company });
  })
);

router.patch(
  "/kyb/:companyId/approve",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const company = await prisma.company.findUnique({ where: { id: req.params.companyId } });
    if (!company) {
      throw new NotFoundError("Company not found");
    }
    if (company.kybStatus !== "PENDING_REVIEW") {
      throw new UnprocessableEntityError("This company isn't awaiting review");
    }

    await prisma.company.update({
      where: { id: company.id },
      data: { kybStatus: "APPROVED", kybReviewedAt: new Date(), kybRejectionReason: null },
    });

    await writeAuditLog({
      action: "KYB_APPROVED",
      actorEmail: await actorEmail(req.userId!),
      targetType: "Company",
      targetId: company.id,
    });

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

    const company = await prisma.company.findUnique({ where: { id: req.params.companyId } });
    if (!company) {
      throw new NotFoundError("Company not found");
    }
    if (company.kybStatus !== "PENDING_REVIEW") {
      throw new UnprocessableEntityError("This company isn't awaiting review");
    }

    await prisma.company.update({
      where: { id: company.id },
      data: { kybStatus: "REJECTED", kybReviewedAt: new Date(), kybRejectionReason: parsed.data.reason },
    });

    await writeAuditLog({
      action: "KYB_REJECTED",
      actorEmail: await actorEmail(req.userId!),
      targetType: "Company",
      targetId: company.id,
      metadata: { reason: parsed.data.reason },
    });

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

    const company = await prisma.company.findUnique({ where: { id: req.params.companyId } });
    if (!company) {
      throw new NotFoundError("Company not found");
    }
    if (company.kybStatus !== "PENDING_REVIEW") {
      throw new UnprocessableEntityError("This company isn't awaiting review");
    }

    await prisma.company.update({
      where: { id: company.id },
      data: { kybStatus: "NEEDS_INFO", kybReviewedAt: new Date(), kybRejectionReason: parsed.data.reason },
    });

    await writeAuditLog({
      action: "KYB_NEEDS_INFO",
      actorEmail: await actorEmail(req.userId!),
      targetType: "Company",
      targetId: company.id,
      metadata: { reason: parsed.data.reason },
    });

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
    const applies = await prisma.creditApply.findMany({
      where: status
        ? { status: status as "PENDING_MAKER" | "PENDING_CHECKER" | "APPROVED" | "REJECTED" }
        : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    const companyIds = Array.from(new Set(applies.map((a) => a.companyId)));
    const companies = await prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } });
    const companyMap = new Map(companies.map((c) => [c.id, c]));

    const userIds = Array.from(
      new Set(applies.flatMap((a) => [a.makerId, a.checkerId, a.submittedById]).filter((id): id is string => !!id))
    );
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } });
    const userMap = new Map(users.map((u) => [u.id, u]));

    const enriched = applies.map((a) => ({
      ...a,
      company: companyMap.get(a.companyId) ?? null,
      maker: a.makerId ? userMap.get(a.makerId) ?? null : null,
      checker: a.checkerId ? userMap.get(a.checkerId) ?? null : null,
      submittedBy: a.submittedById ? userMap.get(a.submittedById) ?? null : null,
    }));

    res.json({ creditApplies: enriched });
  })
);

// Decision-support snapshot shown to staff while reviewing a Credit Apply —
// built from data already in the system (cash flow, overdue bills), not a
// real bureau pull. See getCreditRiskSnapshot for the heuristics used.
router.get(
  "/credit-applies/:id/risk-snapshot",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const creditApply = await prisma.creditApply.findUnique({ where: { id: req.params.id } });
    if (!creditApply) {
      throw new NotFoundError("Credit Apply not found");
    }
    const snapshot = await getCreditRiskSnapshot(creditApply.companyId, Number(creditApply.requestedAmount));
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
    const { companyId, requestedAmount, note } = parsed.data;

    if (requestedAmount < MIN_CREDIT_APPLY_AMOUNT) {
      throw new UnprocessableEntityError(`Minimum credit apply amount is $${MIN_CREDIT_APPLY_AMOUNT.toLocaleString()}.`);
    }

    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      throw new NotFoundError("Company not found");
    }
    if (company.kybStatus !== "APPROVED") {
      throw new UnprocessableEntityError("This company's KYB must be approved before a Credit Apply can be created.");
    }
    if (!company.contractAcceptedAt) {
      throw new UnprocessableEntityError("This company hasn't signed the lending contract yet.");
    }

    const existing = await getActiveCreditApply(companyId);
    if (existing) {
      throw new UnprocessableEntityError("This company already has a pending or approved Credit Apply.");
    }

    const creditApply = await prisma.creditApply.create({
      data: { companyId, requestedAmount, makerNote: note, makerId: req.userId! },
    });

    await writeAuditLog({
      action: "CREDIT_APPLY_CREATED",
      actorEmail: await actorEmail(req.userId!),
      targetType: "CreditApply",
      targetId: creditApply.id,
      metadata: { companyId, requestedAmount: requestedAmount.toString() },
    });

    res.status(201).json({ creditApply });
  })
);

const forwardCreditApplySchema = z.object({
  note: z.string().max(500).optional(),
});

// The "maker" step for a customer-submitted application: a staff member
// reviews it (ideally after checking the risk snapshot) and forwards it into
// the checker queue. Any staff member may forward — the maker/checker split
// only needs to be enforced once it reaches approve/reject, same as before.
router.patch(
  "/credit-applies/:id/forward",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = forwardCreditApplySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const creditApply = await prisma.creditApply.findUnique({ where: { id: req.params.id } });
    if (!creditApply) {
      throw new NotFoundError("Credit Apply not found");
    }
    if (creditApply.status !== "PENDING_MAKER") {
      throw new UnprocessableEntityError("This request isn't awaiting maker review.");
    }

    const updated = await prisma.creditApply.update({
      where: { id: creditApply.id },
      data: {
        status: "PENDING_CHECKER",
        makerId: req.userId,
        makerNote: parsed.data.note,
      },
    });

    await writeAuditLog({
      action: "CREDIT_APPLY_FORWARDED",
      actorEmail: await actorEmail(req.userId!),
      targetType: "CreditApply",
      targetId: creditApply.id,
    });

    res.json({ creditApply: updated });
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

    const creditApply = await prisma.creditApply.findUnique({ where: { id: req.params.id } });
    if (!creditApply) {
      throw new NotFoundError("Credit Apply not found");
    }
    if (creditApply.status !== "PENDING_CHECKER") {
      throw new UnprocessableEntityError("This request has already been reviewed");
    }
    if (creditApply.makerId === req.userId) {
      throw new ForbiddenError("The checker must be a different staff member than the maker.");
    }

    const approvedAmount = parsed.data.approvedAmount ?? Number(creditApply.requestedAmount);
    const offeredInterestRatePct = parsed.data.interestRatePct ?? DEFAULT_INTEREST_RATE_PCT;
    const offeredTermMonths = parsed.data.termMonths ?? DEFAULT_TERM_MONTHS;

    const updated = await prisma.creditApply.update({
      where: { id: creditApply.id },
      data: {
        status: "APPROVED",
        approvedAmount,
        offeredInterestRatePct,
        offeredTermMonths,
        checkerId: req.userId,
        checkerNote: parsed.data.note,
        decidedAt: new Date(),
      },
    });

    await writeAuditLog({
      action: "CREDIT_APPLY_APPROVED",
      actorEmail: await actorEmail(req.userId!),
      targetType: "CreditApply",
      targetId: creditApply.id,
      metadata: { approvedAmount: approvedAmount.toString(), offeredInterestRatePct, offeredTermMonths },
    });

    res.json({ creditApply: updated });
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

    const creditApply = await prisma.creditApply.findUnique({ where: { id: req.params.id } });
    if (!creditApply) {
      throw new NotFoundError("Credit Apply not found");
    }
    if (creditApply.status !== "PENDING_MAKER" && creditApply.status !== "PENDING_CHECKER") {
      throw new UnprocessableEntityError("This request has already been reviewed");
    }
    if (creditApply.status === "PENDING_CHECKER" && creditApply.makerId === req.userId) {
      throw new ForbiddenError("The checker must be a different staff member than the maker.");
    }

    const updated = await prisma.creditApply.update({
      where: { id: creditApply.id },
      data: {
        status: "REJECTED",
        checkerId: req.userId,
        checkerNote: parsed.data.reason,
        decidedAt: new Date(),
      },
    });

    await writeAuditLog({
      action: "CREDIT_APPLY_REJECTED",
      actorEmail: await actorEmail(req.userId!),
      targetType: "CreditApply",
      targetId: creditApply.id,
      metadata: { reason: parsed.data.reason },
    });

    res.json({ creditApply: updated });
  })
);

// ---------------------------------------------------------------------------
// Business detail — full "manage this company" view for Operation staff:
// profile, KYB, contract, credit line, and their cards/budgets/claims.
// ---------------------------------------------------------------------------

router.get(
  "/customers/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const company = await prisma.company.findFirst({
      where: { id: req.params.id, users: { none: { isStaff: true } } },
      include: {
        users: { select: { id: true, name: true, email: true, role: true } },
        accounts: true,
        businessProfile: true,
        beneficialOwners: { orderBy: { createdAt: "asc" } },
        cards: { orderBy: { createdAt: "desc" } },
        budgets: { orderBy: { createdAt: "desc" } },
        claims: { orderBy: { submittedAt: "desc" }, take: 50 },
      },
    });
    if (!company) {
      throw new NotFoundError("Company not found");
    }

    const creditApplies = await prisma.creditApply.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: "desc" },
    });
    const activeCreditApply =
      creditApplies.find((c) => c.status === "PENDING_MAKER" || c.status === "PENDING_CHECKER" || c.status === "APPROVED") ??
      null;
    const drawdowns = await prisma.drawdown.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } });
    const repayments = await prisma.repayment.findMany({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } });
    const monitoring =
      activeCreditApply && activeCreditApply.status === "APPROVED"
        ? await getCreditMonitoring(activeCreditApply.id)
        : null;

    res.json({
      company,
      creditApplies,
      availableAmount: availableAmount(activeCreditApply ?? null),
      monitoring,
      drawdowns,
      repayments,
    });
  })
);

export default router;
