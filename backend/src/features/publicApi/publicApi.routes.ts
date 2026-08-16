import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireApiKey, ApiKeyedRequest } from "../../middleware/apiKey";
import { asyncHandler } from "../../middleware/errorHandler";
import { NotFoundError } from "../../errors/AppError";

// The actual public developer API — everything under /api/v1 is
// authenticated with an ApiKey (x-api-key header) instead of the JWT the
// rest of the app uses, and is scoped read-only to the key's own company.
// Intentionally small: this is a demo of "what a real integration would
// call," not a full mirror of the internal app API.
const router = Router();
router.use(requireApiKey);

router.get(
  "/accounts",
  asyncHandler<ApiKeyedRequest>(async (req, res) => {
    const accounts = await prisma.account.findMany({
      where: { companyId: req.companyId },
      select: { id: true, name: true, type: true, currency: true, balance: true, accountNumber: true, frozen: true },
      orderBy: { createdAt: "asc" },
    });
    res.json({ accounts });
  })
);

router.get(
  "/accounts/:id/transactions",
  asyncHandler<ApiKeyedRequest>(async (req, res) => {
    const account = await prisma.account.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!account) {
      throw new NotFoundError("Account not found");
    }
    const take = Math.min(Math.max(Number(req.query.take) || 25, 1), 100);
    const transactions = await prisma.transaction.findMany({
      where: { accountId: account.id },
      orderBy: { date: "desc" },
      take,
    });
    res.json({ transactions });
  })
);

export default router;
