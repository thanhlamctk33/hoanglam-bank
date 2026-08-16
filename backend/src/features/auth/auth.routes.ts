import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { signToken } from "./jwt.service";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { ConflictError, NotFoundError, UnauthorizedError, UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { getOrCreatePrimaryAccount } from "../credit/credit.service";
import { verifyOtp } from "../../shared/otp/otp.service";

const router = Router();

const registerSchema = z.object({
  companyName: z.string().min(2),
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(6).max(20),
  password: z.string().min(8),
  otp: z.string().min(1),
});

router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { companyName, name, email, phone, password, otp } = parsed.data;

    if (!verifyOtp(otp)) {
      throw new UnprocessableEntityError("Invalid OTP. Use 8888 for this demo.");
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictError("Email already registered");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const company = await prisma.company.create({
      data: {
        name: companyName,
        users: {
          create: { name, email, phone, passwordHash, role: "ADMIN" },
        },
      },
      include: { users: true },
    });

    const user = company.users[0];
    await getOrCreatePrimaryAccount(company.id);
    const token = signToken({ userId: user.id, companyId: company.id });

    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, isStaff: user.isStaff, kycStatus: "NOT_STARTED" },
      company: { id: company.id, name: company.name, tier: company.tier, kybStatus: company.kybStatus },
    });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { email },
      include: { company: true, kycProfile: true },
    });
    if (!user) {
      throw new UnauthorizedError("Invalid email or password");
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedError("Invalid email or password");
    }

    const token = signToken({ userId: user.id, companyId: user.companyId });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isStaff: user.isStaff,
        kycStatus: user.kycProfile?.status ?? "NOT_STARTED",
      },
      company: { id: user.company.id, name: user.company.name, tier: user.company.tier, kybStatus: user.company.kybStatus },
    });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { company: true, kycProfile: true },
    });
    if (!user) {
      throw new NotFoundError("User not found");
    }
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isStaff: user.isStaff,
        kycStatus: user.kycProfile?.status ?? "NOT_STARTED",
      },
      company: { id: user.company.id, name: user.company.name, tier: user.company.tier, kybStatus: user.company.kybStatus },
    });
  })
);

export default router;
