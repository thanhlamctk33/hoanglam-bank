import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { BadRequestError, ForbiddenError, LockedError, NotFoundError, TooManyRequestsError, UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { PLANS } from "../subscription/plans.config";
import { getCompanyTier } from "../subscription/subscription.service";
import { checkTransactionAllowed } from "../kyb/kyb.service";
import { verifyOtp } from "../../shared/otp/otp.service";
import { canDebit, chargeOverdraftFeeIfNeeded } from "../../shared/overdraft/overdraft.service";
import { checkVelocity, flagIfAnomalous } from "../../shared/fraud/fraud.service";

const router = Router();
router.use(requireAuth);

export const UTILITY_PROVIDERS = [
  { id: "evn", name: "EVN - Electricity", category: "Electricity" },
  { id: "sawaco", name: "Sawaco - Water Supply", category: "Water" },
  { id: "fpt", name: "FPT Telecom - Internet", category: "Internet" },
  { id: "tuition", name: "Online Tuition", category: "Tuition" },
  { id: "insurance", name: "Life Insurance", category: "Insurance" },
] as const;

router.get(
  "/utility/providers",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    res.json({ providers: UTILITY_PROVIDERS });
  })
);

const utilitySchema = z.object({
  accountId: z.string().uuid(),
  providerId: z.enum(UTILITY_PROVIDERS.map((p) => p.id) as [string, ...string[]]),
  customerCode: z.string().min(1).max(50),
  amount: z.number().positive(),
});

router.post(
  "/utility",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = utilitySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { accountId, providerId, customerCode, amount } = parsed.data;
    const provider = UTILITY_PROVIDERS.find((p) => p.id === providerId)!;

    const account = await prisma.account.findFirst({ where: { id: accountId, companyId: req.companyId } });
    if (!account) {
      throw new NotFoundError("Account not found");
    }
    if (account.frozen) {
      throw new LockedError("This account is frozen");
    }

    const tier = await getCompanyTier(req.companyId!);
    const plan = PLANS[tier];
    const discountAmount = Math.round(amount * (plan.spendDiscountPct / 100) * 100) / 100;
    const amountCharged = Math.round((amount - discountAmount) * 100) / 100;

    if (!canDebit(account, amountCharged)) {
      throw new UnprocessableEntityError("Insufficient balance");
    }

    const velocityCheck = await checkVelocity(req.companyId!, account.id);
    if (!velocityCheck.ok) {
      throw new TooManyRequestsError(velocityCheck.error);
    }

    const kybCheck = await checkTransactionAllowed(req.companyId!, amount);
    if (!kybCheck.allowed) {
      throw new ForbiddenError(kybCheck.message);
    }

    const description =
      discountAmount > 0
        ? `Payment for ${provider.name} - ${customerCode} (${plan.spendDiscountPct}% ${plan.name} plan discount applied)`
        : `Payment for ${provider.name} - ${customerCode}`;
    const utilityBalanceBefore = Number(account.balance);

    const transaction = await prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id: account.id }, data: { balance: { decrement: amountCharged } } });
      await chargeOverdraftFeeIfNeeded(tx, account, utilityBalanceBefore, utilityBalanceBefore - amountCharged);
      return tx.transaction.create({
        data: {
          accountId: account.id,
          amount: amountCharged,
          currency: account.currency,
          type: "DEBIT",
          description,
          category: provider.category,
          merchant: provider.name,
        },
      });
    });

    await flagIfAnomalous(transaction.id, account.id, amountCharged);

    res.status(201).json({ transaction, originalAmount: amount, discountAmount, amountCharged });
  })
);

router.get(
  "/qr/my-code",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const accountIdParam = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
    const account = accountIdParam
      ? await prisma.account.findFirst({ where: { id: accountIdParam, companyId: req.companyId } })
      : await prisma.account.findFirst({ where: { companyId: req.companyId } });
    if (!account) {
      throw new NotFoundError("No account found");
    }

    const amountParam = typeof req.query.amount === "string" ? req.query.amount : undefined;
    const amount = amountParam && Number(amountParam) > 0 ? Number(amountParam) : undefined;
    const note = typeof req.query.note === "string" ? req.query.note.trim() : "";

    // Payload format: HLBQR:<accountNumber> for a plain "pay me" code, or
    // HLBQR:<accountNumber>|<amount>|<note> when the merchant is requesting a
    // specific amount — the note is URL-encoded since it can contain "|".
    const payload = amount
      ? `HLBQR:${account.accountNumber}|${amount}|${encodeURIComponent(note)}`
      : `HLBQR:${account.accountNumber}`;

    res.json({
      accountId: account.id,
      accountNumber: account.accountNumber,
      accountName: account.name,
      currency: account.currency,
      requestedAmount: amount ?? null,
      note: note || null,
      payload,
    });
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
    const parsed = qrPaySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const { fromAccountId, payload, amount, note, otp } = parsed.data;

    if (!verifyOtp(otp)) {
      throw new UnprocessableEntityError("Invalid OTP. Use 8888 for this demo.");
    }

    const match = /^HLBQR:(.+)$/.exec(payload.trim());
    if (!match) {
      throw new BadRequestError("Invalid QR code");
    }
    const toAccountNumber = match[1];

    const fromAccount = await prisma.account.findFirst({
      where: { id: fromAccountId, companyId: req.companyId },
    });
    if (!fromAccount) {
      throw new NotFoundError("Source account not found");
    }
    if (fromAccount.frozen) {
      throw new LockedError("This account is frozen");
    }

    const toAccount = await prisma.account.findUnique({ where: { accountNumber: toAccountNumber } });
    if (!toAccount) {
      throw new NotFoundError("QR merchant account not found");
    }
    if (toAccount.id === fromAccount.id) {
      throw new BadRequestError("Cannot pay yourself");
    }
    if (!canDebit(fromAccount, amount)) {
      throw new UnprocessableEntityError("Insufficient balance");
    }

    const qrVelocityCheck = await checkVelocity(req.companyId!, fromAccount.id);
    if (!qrVelocityCheck.ok) {
      throw new TooManyRequestsError(qrVelocityCheck.error);
    }

    const kybCheck = await checkTransactionAllowed(req.companyId!, amount);
    if (!kybCheck.allowed) {
      throw new ForbiddenError(kybCheck.message);
    }

    const qrBalanceBefore = Number(fromAccount.balance);

    const transaction = await prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id: fromAccount.id }, data: { balance: { decrement: amount } } });
      await tx.account.update({ where: { id: toAccount.id }, data: { balance: { increment: amount } } });
      await chargeOverdraftFeeIfNeeded(tx, fromAccount, qrBalanceBefore, qrBalanceBefore - amount);

      const debit = await tx.transaction.create({
        data: {
          accountId: fromAccount.id,
          amount,
          currency: fromAccount.currency,
          type: "DEBIT",
          description: note?.trim() || `QR Pay to ${toAccount.accountNumber}`,
          category: "QR Pay",
          merchant: toAccount.accountNumber,
        },
      });
      await tx.transaction.create({
        data: {
          accountId: toAccount.id,
          amount,
          currency: toAccount.currency,
          type: "CREDIT",
          description: note?.trim() || `QR Pay from ${fromAccount.accountNumber}`,
          category: "QR Pay",
          merchant: fromAccount.accountNumber,
        },
      });

      return debit;
    });

    await flagIfAnomalous(transaction.id, fromAccount.id, amount);

    res.status(201).json({ transaction });
  })
);

export default router;
