import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { BadRequestError, ConflictError, NotFoundError, UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { MAX_ADMINS_PER_COMPANY } from "./team.config";

const router = Router();
router.use(requireAuth);

const memberSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
} as const;

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const members = await prisma.user.findMany({
      where: { companyId: req.companyId },
      select: memberSelect,
      orderBy: { createdAt: "asc" },
    });
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
    const parsed = addMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (existing) {
      throw new ConflictError("Email already registered");
    }

    if (parsed.data.role === "ADMIN") {
      const adminCount = await prisma.user.count({ where: { companyId: req.companyId, role: "ADMIN" } });
      if (adminCount >= MAX_ADMINS_PER_COMPANY) {
        throw new UnprocessableEntityError(`Your company can have at most ${MAX_ADMINS_PER_COMPANY} Admins.`);
      }
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    const member = await prisma.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        passwordHash,
        role: parsed.data.role,
        companyId: req.companyId!,
      },
      select: memberSelect,
    });

    res.status(201).json({ member });
  })
);

const roleSchema = z.object({ role: z.enum(["ADMIN", "MEMBER"]) });

router.patch(
  "/:id/role",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const member = await prisma.user.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!member) {
      throw new NotFoundError("Member not found");
    }
    if (member.id === req.userId) {
      throw new BadRequestError("You can't change your own role");
    }
    if (member.role === "ADMIN" && parsed.data.role !== "ADMIN") {
      const adminCount = await prisma.user.count({ where: { companyId: req.companyId, role: "ADMIN" } });
      if (adminCount <= 1) {
        throw new UnprocessableEntityError("Your company needs at least one Admin");
      }
    }
    if (member.role !== "ADMIN" && parsed.data.role === "ADMIN") {
      const adminCount = await prisma.user.count({ where: { companyId: req.companyId, role: "ADMIN" } });
      if (adminCount >= MAX_ADMINS_PER_COMPANY) {
        throw new UnprocessableEntityError(`Your company can have at most ${MAX_ADMINS_PER_COMPANY} Admins.`);
      }
    }

    const updated = await prisma.user.update({
      where: { id: member.id },
      data: { role: parsed.data.role },
      select: memberSelect,
    });
    res.json({ member: updated });
  })
);

router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const member = await prisma.user.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!member) {
      throw new NotFoundError("Member not found");
    }
    if (member.id === req.userId) {
      throw new BadRequestError("You can't remove yourself");
    }
    if (member.role === "ADMIN") {
      const adminCount = await prisma.user.count({ where: { companyId: req.companyId, role: "ADMIN" } });
      if (adminCount <= 1) {
        throw new UnprocessableEntityError("Your company needs at least one Admin");
      }
    }

    await prisma.user.delete({ where: { id: member.id } });
    res.status(204).end();
  })
);

export default router;
