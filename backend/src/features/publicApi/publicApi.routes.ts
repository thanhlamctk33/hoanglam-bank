import { Router } from "express";
import { requireApiKey, ApiKeyedRequest } from "../../middleware/apiKey";
import { asyncHandler } from "../../middleware/errorHandler";
import * as publicApiService from "./publicApi.service";

// The actual public developer API — everything under /api/v1 is
// authenticated with an ApiKey (x-api-key header) instead of the JWT the
// rest of the app uses, and is scoped read-only to the key's own company.
const router = Router();
router.use(requireApiKey);

router.get(
  "/accounts",
  asyncHandler<ApiKeyedRequest>(async (req, res) => {
    const accounts = await publicApiService.listAccounts(req.companyId);
    res.json({ accounts });
  })
);

router.get(
  "/accounts/:id/transactions",
  asyncHandler<ApiKeyedRequest>(async (req, res) => {
    const take = Math.min(Math.max(Number(req.query.take) || 25, 1), 100);
    const transactions = await publicApiService.listAccountTransactions(req.companyId, req.params.id, take);
    res.json({ transactions });
  })
);

export default router;
