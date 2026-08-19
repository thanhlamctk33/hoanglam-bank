import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { requireCompanyAdmin } from "../../../middleware/companyAdmin";
import { asyncHandler } from "../../../middleware/errorHandler";
import { ValidationError } from "../../../errors/AppError";
import * as teamService from "./team.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const members = await teamService.listMembers(req.companyId);
    res.json({ members });
  })
);

const addMemberSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
});

router.post(
  "/",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = addMemberSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const member = await teamService.addMember(req.companyId, parsedBody.data);
    res.status(201).json({ member });
  })
);

const roleSchema = z.object({ role: z.enum(["ADMIN", "MEMBER"]) });

router.patch(
  "/:id/role",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = roleSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const member = await teamService.changeMemberRole(req.companyId, req.params.id, parsedBody.data.role, req.userId);
    res.json({ member });
  })
);

router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    await teamService.removeMember(req.companyId, req.params.id, req.userId);
    res.status(204).end();
  })
);

export default router;
