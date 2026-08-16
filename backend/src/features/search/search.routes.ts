import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";

const router = Router();
router.use(requireAuth);

const RESULT_LIMIT = 5;

// Cross-entity search over data that already exists — no new table. Each
// page (Cards, Budgets, ...) still has its own local filter via the shared
// search query; this endpoint additionally powers a global "jump to"
// dropdown in the Topbar so a query can surface results outside the page
// you're currently on.
router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) {
      return res.json({ transactions: [], cards: [], budgets: [], bills: [], claims: [] });
    }

    const companyId = req.companyId!;
    const contains = { contains: q, mode: "insensitive" as const };

    const [transactions, cards, budgets, bills, claims] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          account: { companyId },
          OR: [{ description: contains }, { merchant: contains }, { category: contains }],
        },
        orderBy: { date: "desc" },
        take: RESULT_LIMIT,
        select: {
          id: true,
          description: true,
          merchant: true,
          category: true,
          amount: true,
          currency: true,
          type: true,
          date: true,
          accountId: true,
        },
      }),
      prisma.card.findMany({
        where: { companyId, label: contains },
        orderBy: { createdAt: "desc" },
        take: RESULT_LIMIT,
        select: { id: true, label: true, status: true, last4: true },
      }),
      prisma.budget.findMany({
        where: { companyId, name: contains },
        orderBy: { createdAt: "desc" },
        take: RESULT_LIMIT,
        select: { id: true, name: true, status: true, amount: true, currency: true },
      }),
      prisma.bill.findMany({
        where: { companyId, vendor: contains },
        orderBy: { dueDate: "desc" },
        take: RESULT_LIMIT,
        select: { id: true, vendor: true, status: true, amount: true, currency: true, dueDate: true },
      }),
      prisma.claim.findMany({
        where: { companyId, title: contains },
        orderBy: { submittedAt: "desc" },
        take: RESULT_LIMIT,
        select: { id: true, title: true, status: true, amount: true, currency: true },
      }),
    ]);

    res.json({ transactions, cards, budgets, bills, claims });
  })
);

export default router;
