import { Router } from "express";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/errorHandler";
import * as searchService from "./search.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const searchQuery = typeof req.query.q === "string" ? req.query.q : "";
    const results = await searchService.searchAll(req.companyId, searchQuery);
    res.json(results);
  })
);

export default router;
