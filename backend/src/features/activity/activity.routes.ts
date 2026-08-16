import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";

const router = Router();
router.use(requireAuth);

// A company-scoped view over the shared AuditLog table. AuditLog has no
// companyId column (it's also used for bank-staff cross-company actions), so
// this filters by actorEmail belonging to one of the company's own users —
// email is globally unique, so that's an exact, safe scope. No new table.
router.get(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const members = await prisma.user.findMany({
      where: { companyId: req.companyId },
      select: { name: true, email: true },
    });
    const emails = members.map((m) => m.email);
    if (emails.length === 0) {
      return res.json({ entries: [] });
    }
    const nameByEmail = new Map(members.map((m) => [m.email, m.name]));

    const take = Math.min(Math.max(Number(req.query.take) || 100, 1), 200);

    const rows = await prisma.auditLog.findMany({
      where: { actorEmail: { in: emails } },
      orderBy: { createdAt: "desc" },
      take,
    });

    const entries = rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorEmail: r.actorEmail,
      actorName: nameByEmail.get(r.actorEmail) ?? r.actorEmail,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
      createdAt: r.createdAt,
    }));

    res.json({ entries });
  })
);

export default router;
