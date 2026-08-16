import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { NotFoundError, UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { getActiveCreditApply, availableAmount, getCreditMonitoring } from "./credit.service";
import { MIN_CREDIT_APPLY_AMOUNT, DEFAULT_INTEREST_RATE_PCT, DEFAULT_TERM_MONTHS } from "./lending.config";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const company = await prisma.company.findUnique({
      where: { id: req.companyId },
      select: { kybStatus: true, contractAcceptedAt: true },
    });

    const activeCreditApply = await getActiveCreditApply(req.companyId!);
    const history = await prisma.creditApply.findMany({
      where: { companyId: req.companyId },
      orderBy: { createdAt: "desc" },
    });

    const monitoring =
      activeCreditApply && activeCreditApply.status === "APPROVED"
        ? await getCreditMonitoring(activeCreditApply.id)
        : null;

    res.json({
      kybStatus: company?.kybStatus ?? "NOT_STARTED",
      contractAcceptedAt: company?.contractAcceptedAt ?? null,
      creditApply: activeCreditApply,
      availableAmount: availableAmount(activeCreditApply),
      monitoring,
      history,
    });
  })
);

const applySchema = z.object({
  requestedAmount: z.number().positive(),
  purpose: z.string().max(500).optional(),
});

// Lets a company apply for its own credit line instead of waiting for a bank
// contact to submit one on their behalf. Starts at PENDING_MAKER — a staff
// member still reviews it (and can see a risk snapshot) before forwarding it
// to a different staff member (checker) for the final call.
router.post(
  "/apply",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { requestedAmount, purpose } = parsed.data;

    if (requestedAmount < MIN_CREDIT_APPLY_AMOUNT) {
      throw new UnprocessableEntityError(`Minimum credit apply amount is $${MIN_CREDIT_APPLY_AMOUNT.toLocaleString()}.`);
    }

    const company = await prisma.company.findUnique({ where: { id: req.companyId } });
    if (!company) {
      throw new NotFoundError("Company not found");
    }
    if (company.kybStatus !== "APPROVED") {
      throw new UnprocessableEntityError("Complete business verification (KYB) before applying for credit.");
    }
    if (!company.contractAcceptedAt) {
      throw new UnprocessableEntityError("Sign the lending contract before applying for credit.");
    }

    const existing = await getActiveCreditApply(req.companyId!);
    if (existing) {
      throw new UnprocessableEntityError("You already have a credit application in progress or an active line.");
    }

    const creditApply = await prisma.creditApply.create({
      data: {
        companyId: req.companyId!,
        requestedAmount,
        purpose,
        submittedById: req.userId!,
        status: "PENDING_MAKER",
      },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "CREDIT_APPLY_SUBMITTED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "CreditApply",
      targetId: creditApply.id,
      metadata: { requestedAmount: requestedAmount.toString() },
    });

    res.status(201).json({ creditApply });
  })
);

// Testing/demo convenience: wipes this company's lending history (CreditApply
// + Drawdown + Repayment rows) so the apply-for-credit flow can be tried
// again from a clean slate. Deliberately leaves account balances and past
// Transactions untouched — those stay as a record of money that already
// moved, same as if a real loan had simply been paid off and closed.
router.post(
  "/reset-demo",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const companyId = req.companyId!;

    await prisma.drawdown.deleteMany({ where: { companyId } });
    await prisma.repayment.deleteMany({ where: { companyId } });
    await prisma.creditApply.deleteMany({ where: { companyId } });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "CREDIT_DEMO_RESET",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Company",
      targetId: companyId,
    });

    res.json({ ok: true });
  })
);

// Testing/demo convenience: skips the maker-checker review entirely and
// approves whatever's pending (PENDING_MAKER or PENDING_CHECKER) at the
// app-wide default rate/tenor, so the Drawdown/Repayment tabs have
// something to work with without needing two separate staff logins. Real
// approvals still go through /admin/credit-applies/:id/approve.
router.post(
  "/auto-approve-demo",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const creditApply = await getActiveCreditApply(req.companyId!);
    if (!creditApply) {
      throw new UnprocessableEntityError("No credit application to approve.");
    }
    if (creditApply.status === "APPROVED") {
      throw new UnprocessableEntityError("This credit line is already approved.");
    }
    if (creditApply.status === "REJECTED") {
      throw new UnprocessableEntityError("This application was rejected — apply again first.");
    }

    const staffUsers = await prisma.user.findMany({ where: { isStaff: true }, take: 2 });
    const makerId = creditApply.makerId ?? staffUsers[0]?.id ?? null;
    const checkerId = staffUsers[1]?.id ?? staffUsers[0]?.id ?? null;

    const updated = await prisma.creditApply.update({
      where: { id: creditApply.id },
      data: {
        status: "APPROVED",
        approvedAmount: creditApply.approvedAmount ?? creditApply.requestedAmount,
        offeredInterestRatePct: creditApply.offeredInterestRatePct ?? DEFAULT_INTEREST_RATE_PCT,
        offeredTermMonths: creditApply.offeredTermMonths ?? DEFAULT_TERM_MONTHS,
        makerId,
        checkerId,
        checkerNote: "Auto-approved for testing.",
        decidedAt: new Date(),
      },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "CREDIT_APPLY_AUTO_APPROVED_DEMO",
      actorEmail: actor?.email ?? "unknown",
      targetType: "CreditApply",
      targetId: creditApply.id,
    });

    res.json({ creditApply: updated });
  })
);

router.post(
  "/accept-contract",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const company = await prisma.company.findUnique({ where: { id: req.companyId } });
    if (!company) {
      throw new NotFoundError("Company not found");
    }
    if (company.kybStatus !== "APPROVED") {
      throw new UnprocessableEntityError("Complete business verification (KYB) before accepting lending terms.");
    }
    if (company.contractAcceptedAt) {
      throw new UnprocessableEntityError("Contract already signed.");
    }

    const updated = await prisma.company.update({
      where: { id: company.id },
      data: { contractAcceptedAt: new Date() },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "CONTRACT_SIGNED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Company",
      targetId: company.id,
    });

    res.json({ contractAcceptedAt: updated.contractAcceptedAt });
  })
);

export default router;
