import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/errorHandler";
import { ValidationError } from "../../../errors/AppError";
import { UTILITY_PROVIDERS } from "./payments.config";
import * as paymentsService from "./payments.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/utility/providers",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    res.json({ providers: UTILITY_PROVIDERS });
  })
);

const utilitySchema = z.object({
  accountId: z.string().uuid(),
  providerId: z.enum(UTILITY_PROVIDERS.map((provider) => provider.id) as [string, ...string[]]),
  customerCode: z.string().min(1).max(50),
  amount: z.number().positive(),
});

router.post(
  "/utility",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = utilitySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const result = await paymentsService.payUtility(req.companyId, parsedBody.data);
    res.status(201).json(result);
  })
);

router.get(
  "/qr/my-code",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const accountId = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
    const amountParam = typeof req.query.amount === "string" ? req.query.amount : undefined;
    const note = typeof req.query.note === "string" ? req.query.note : undefined;

    const code = await paymentsService.getMyQrCode(req.companyId, {
      accountId,
      amount: amountParam ? Number(amountParam) : undefined,
      note,
    });
    res.json(code);
  })
);

const qrPaySchema = z.object({
  fromAccountId: z.string().uuid(),
  payload: z.string().min(1),
  amount: z.number().positive(),
  note: z.string().max(200).optional(),
  otp: z.string().min(1),
});

router.post(
  "/qr/pay",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = qrPaySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const transaction = await paymentsService.payByQr(req.companyId, parsedBody.data);
    res.status(201).json({ transaction });
  })
);

export default router;
