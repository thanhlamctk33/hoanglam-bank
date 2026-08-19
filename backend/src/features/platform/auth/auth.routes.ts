import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/errorHandler";
import { ValidationError } from "../../../errors/AppError";
import * as authService from "./auth.service";

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
    const parsedBody = registerSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const result = await authService.register(parsedBody.data);
    res.status(201).json(result);
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const parsedBody = loginSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const result = await authService.login(parsedBody.data.email, parsedBody.data.password);
    res.json(result);
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const result = await authService.getCurrentUser(req.userId);
    res.json(result);
  })
);

// Invalidates every token this user holds, then hands back a fresh one so the
// device making the request stays signed in.
router.post(
  "/sign-out-everywhere",
  requireAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const result = await authService.signOutEverywhere(req.userId);
    res.json(result);
  })
);

export default router;
