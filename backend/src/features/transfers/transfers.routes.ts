import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { ValidationError } from "../../errors/AppError";
import { FX_CURRENCIES } from "../../shared/fx/fx.service";
import * as transfersService from "./transfers.service";

const router = Router();
router.use(requireAuth);

router.get(
  "/recent-recipients",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const recipients = await transfersService.listRecentRecipients(req.companyId);
    res.json({ recipients });
  })
);

router.get(
  "/recurring",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const schedules = await transfersService.listRecurringTransfers(req.companyId);
    res.json({ schedules });
  })
);

const createRecurringSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountNumber: z.string().min(1),
  amount: z.number().positive(),
  note: z.string().max(200).optional(),
  frequency: z.enum(["WEEKLY", "MONTHLY"]),
  startDate: z.string().datetime().optional(),
});

router.post(
  "/recurring",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createRecurringSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const schedule = await transfersService.createRecurringTransfer(req.companyId, req.userId, parsed.data);
    res.status(201).json({ schedule });
  })
);

const updateRecurringSchema = z.object({ active: z.boolean() });

router.patch(
  "/recurring/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = updateRecurringSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const schedule = await transfersService.setRecurringTransferActive(req.companyId, req.params.id, parsed.data.active);
    res.json({ schedule });
  })
);

router.delete(
  "/recurring/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await transfersService.deleteRecurringTransfer(req.companyId, req.params.id);
    res.status(204).end();
  })
);

// Internal transfer accepts either a typed account number or a scanned/uploaded
// QR payload (format "HLBQR:<accountNumber>") — the two entry methods from the
// Transfer page's "Account number" / "Upload QR" tabs both resolve here.
const transferSchema = z
  .object({
    fromAccountId: z.string().uuid(),
    toAccountNumber: z.string().min(1).optional(),
    qrPayload: z.string().min(1).optional(),
    amount: z.number().positive(),
    note: z.string().max(200).optional(),
    merchantCategory: z.string().optional(),
    otp: z.string().min(1),
  })
  .refine((d) => !!d.toAccountNumber || !!d.qrPayload, {
    message: "Provide either a recipient account number or a scanned QR code",
    path: ["toAccountNumber"],
  });

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const transaction = await transfersService.executeInternalTransfer(req.companyId, req.userId, parsed.data);
    res.status(201).json({ transaction });
  })
);

const fxTransferSchema = z.object({
  fromAccountId: z.string().uuid(),
  targetCurrency: z.enum(FX_CURRENCIES),
  amount: z.number().positive(),
  recipientName: z.string().min(1).max(120),
  recipientAccount: z.string().min(1).max(120),
  note: z.string().max(200).optional(),
  merchantCategory: z.string().optional(),
  otp: z.string().min(1),
});

router.post(
  "/fx",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = fxTransferSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const result = await transfersService.executeFxTransfer(req.companyId, req.userId, parsed.data);
    res.status(201).json(result);
  })
);

const wireTransferSchema = z.object({
  fromAccountId: z.string().uuid(),
  bankName: z.string().min(1).max(120),
  routingNumber: z.string().min(1).max(34),
  recipientName: z.string().min(1).max(120),
  recipientAccount: z.string().min(1).max(120),
  amount: z.number().positive(),
  note: z.string().max(200).optional(),
  merchantCategory: z.string().optional(),
  otp: z.string().min(1),
});

router.post(
  "/wire",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = wireTransferSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const result = await transfersService.executeWireTransfer(req.companyId, req.userId, parsed.data);
    res.status(201).json(result);
  })
);

export default router;
