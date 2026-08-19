import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { requireCompanyAdmin } from "../../../middleware/companyAdmin";
import { asyncHandler } from "../../../middleware/errorHandler";
import { ValidationError } from "../../../errors/AppError";
import * as categoriesService from "./categories.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const categories = await categoriesService.listCategories(req.companyId);
    res.json({ categories });
  })
);

const createSchema = z.object({
  name: z.string().min(1).max(40),
});

router.post(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = createSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const category = await categoriesService.createCategory(req.companyId, req.userId, parsedBody.data.name);
    res.status(201).json({ category });
  })
);

router.post(
  "/reset",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const categories = await categoriesService.resetCategories(req.companyId, req.userId);
    res.json({ categories });
  })
);

router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    await categoriesService.deleteCategory(req.companyId, req.params.id, req.userId);
    res.status(204).end();
  })
);

export default router;
