import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import { BadRequestError, ForbiddenError, LockedError, NotFoundError, TooManyRequestsError, UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { checkTransactionAllowed } from "../kyb/kyb.service";
import { verifyOtp } from "../../shared/otp/otp.service";
import { convertCurrency, FX_CURRENCIES, FX_FEE_PCT } from "../../shared/fx/fx.service";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { canDebit, chargeOverdraftFeeIfNeeded } from "../../shared/overdraft/overdraft.service";
import { OVERDRAFT_FEE } from "../../shared/overdraft/overdraft.config";
import { checkVelocity, flagIfAnomalous } from "../../shared/fraud/fraud.service";
import { PLANS } from "../subscription/plans.config";
import { getCompanyTier } from "../subscription/subscription.service";

/**
 * Applies the company's plan-based transferDiscountPct to a base transfer
 * fee. Used for both the FX percentage fee and the flat wire fee — same
 * discount mechanism as the bill-payment discount in features/payments,
 * just applied to the fee instead of the payment amount.
 */
function applyTransferDiscount(baseFeeAmount: number, transferDiscountPct: number) {
  const discountAmount = Math.round(baseFeeAmount * (transferDiscountPct / 100) * 100) / 100;
  const feeAmount = Math.round((baseFeeAmount - discountAmount) * 100) / 100;
  return { baseFeeAmount, discountAmount, feeAmount };
}

const router = Router();
router.use(requireAuth);

// Recent recipients: derived from the account's own transaction history rather
// than a dedicated table, so there's nothing new to migrate. Internal transfers
// store the destination account number as `merchant`; FX transfers store
// "<name> (<account>) → <currency>"; wire transfers store "<name> (<account>) @ <bank>" —
// all three formats can be parsed back out.
router.get(
  "/recent-recipients",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await prisma.transaction.findMany({
      where: {
        type: "DEBIT",
        category: { in: ["Transfer", "FX Transfer", "Wire Transfer"] },
        account: { companyId: req.companyId },
      },
      orderBy: { date: "desc" },
      take: 100,
      select: { category: true, merchant: true, date: true },
    });

    type Recipient =
      | { type: "internal"; accountNumber: string; lastUsedAt: string }
      | { type: "fx"; recipientName: string; recipientAccount: string; targetCurrency: string; lastUsedAt: string }
      | { type: "wire"; recipientName: string; recipientAccount: string; bankName: string; lastUsedAt: string };

    const seen = new Set<string>();
    const recipients: Recipient[] = [];

    for (const row of rows) {
      if (recipients.length >= 5) break;
      if (!row.merchant) continue;

      if (row.category === "Transfer") {
        const key = `internal:${row.merchant}`;
        if (seen.has(key)) continue;
        seen.add(key);
        recipients.push({ type: "internal", accountNumber: row.merchant, lastUsedAt: row.date.toISOString() });
      } else if (row.category === "FX Transfer") {
        const match = /^(.*) \(([^)]+)\) → (\w+)$/.exec(row.merchant);
        if (!match) continue;
        const [, recipientName, recipientAccount, targetCurrency] = match;
        const key = `fx:${recipientAccount}`;
        if (seen.has(key)) continue;
        seen.add(key);
        recipients.push({ type: "fx", recipientName, recipientAccount, targetCurrency, lastUsedAt: row.date.toISOString() });
      } else if (row.category === "Wire Transfer") {
        const match = /^(.*) \(([^)]+)\) @ (.+)$/.exec(row.merchant);
        if (!match) continue;
        const [, recipientName, recipientAccount, bankName] = match;
        const key = `wire:${recipientAccount}`;
        if (seen.has(key)) continue;
        seen.add(key);
        recipients.push({ type: "wire", recipientName, recipientAccount, bankName, lastUsedAt: row.date.toISOString() });
      }
    }

    res.json({ recipients });
  })
);

function advanceSchedule(date: Date, frequency: "WEEKLY" | "MONTHLY"): Date {
  const next = new Date(date);
  if (frequency === "WEEKLY") {
    next.setDate(next.getDate() + 7);
  } else {
    next.setMonth(next.getMonth() + 1);
  }
  return next;
}

// No background worker exists in this app, so recurring transfers run
// lazily: whenever GET /transfers/recurring is called, each active schedule
// with nextRunAt <= now executes ONE transfer (reusing the same
// money-movement logic as POST /), then nextRunAt is rolled forward to the
// next future occurrence. If a schedule was due multiple times since the
// last visit, this intentionally fires only once rather than bulk-catching
// up every missed occurrence, to avoid a surprise burst of transfers.
//
// The destination account number doesn't have to belong to a LamBank
// account — same as FX/Wire transfers, it can be any account number. If it
// happens to match a LamBank account, this posts a normal two-leg internal
// transfer (debit + credit). Otherwise it's treated as an external payout:
// only the source account is debited, same as a wire leaving the bank.
async function processDueRecurringTransfers(companyId: string) {
  const due = await prisma.recurringTransfer.findMany({
    where: { companyId, active: true, nextRunAt: { lte: new Date() } },
  });

  for (const schedule of due) {
    const fromAccount = await prisma.account.findUnique({ where: { id: schedule.fromAccountId } });
    const toAccount = await prisma.account.findUnique({ where: { accountNumber: schedule.toAccountNumber } });
    const amount = Number(schedule.amount);

    let nextRunAt = advanceSchedule(schedule.nextRunAt, schedule.frequency);
    while (nextRunAt <= new Date()) {
      nextRunAt = advanceSchedule(nextRunAt, schedule.frequency);
    }

    if (
      !fromAccount ||
      fromAccount.companyId !== companyId ||
      fromAccount.frozen ||
      (toAccount && toAccount.id === fromAccount.id) ||
      !canDebit(fromAccount, amount)
    ) {
      // Can't run this occurrence (frozen, insufficient funds, destination is
      // the same account, ...) — skip it and try again next occurrence
      // rather than blocking the whole loop or erroring with nobody to show
      // it to.
      await prisma.recurringTransfer.update({ where: { id: schedule.id }, data: { nextRunAt } });
      continue;
    }

    const kybCheck = await checkTransactionAllowed(companyId, amount);
    if (!kybCheck.allowed) {
      await prisma.recurringTransfer.update({ where: { id: schedule.id }, data: { nextRunAt } });
      continue;
    }

    const description = schedule.note?.trim() || `Recurring transfer to ${schedule.toAccountNumber}`;

    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.account.update({ where: { id: fromAccount.id }, data: { balance: { decrement: amount } } }),
      prisma.transaction.create({
        data: {
          accountId: fromAccount.id,
          amount,
          currency: fromAccount.currency,
          type: "DEBIT",
          description,
          category: "Transfer",
          merchant: schedule.toAccountNumber,
        },
      }),
    ];

    if (toAccount) {
      ops.push(
        prisma.account.update({ where: { id: toAccount.id }, data: { balance: { increment: amount } } }),
        prisma.transaction.create({
          data: {
            accountId: toAccount.id,
            amount,
            currency: toAccount.currency,
            type: "CREDIT",
            description: schedule.note?.trim() || `Transfer from ${fromAccount.accountNumber}`,
            category: "Transfer",
            merchant: fromAccount.accountNumber,
          },
        })
      );
    }

    const balanceBefore = Number(fromAccount.balance);
    if (balanceBefore >= 0 && balanceBefore - amount < 0) {
      ops.push(
        prisma.account.update({ where: { id: fromAccount.id }, data: { balance: { decrement: OVERDRAFT_FEE } } }),
        prisma.transaction.create({
          data: {
            accountId: fromAccount.id,
            amount: OVERDRAFT_FEE,
            currency: fromAccount.currency,
            type: "DEBIT",
            description: "Overdraft fee",
            category: "Overdraft fee",
          },
        })
      );
    }

    ops.push(
      prisma.recurringTransfer.update({
        where: { id: schedule.id },
        data: { nextRunAt, lastRunAt: new Date() },
      })
    );

    await prisma.$transaction(ops);

    await writeAuditLog({
      action: "RECURRING_TRANSFER_RUN",
      actorEmail: "system:recurring",
      targetType: "RecurringTransfer",
      targetId: schedule.id,
      metadata: { amount: amount.toString(), toAccountNumber: schedule.toAccountNumber, external: !toAccount },
    });
  }
}

router.get(
  "/recurring",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await processDueRecurringTransfers(req.companyId!);
    const schedules = await prisma.recurringTransfer.findMany({
      where: { companyId: req.companyId },
      orderBy: { createdAt: "desc" },
    });
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
    const { fromAccountId, toAccountNumber, amount, note, frequency, startDate } = parsed.data;

    const fromAccount = await prisma.account.findFirst({ where: { id: fromAccountId, companyId: req.companyId } });
    if (!fromAccount) {
      throw new NotFoundError("Source account not found");
    }
    // The destination doesn't have to be a LamBank account — same as FX/Wire
    // transfers, any account number is accepted. If it matches a LamBank
    // account when the schedule runs, money moves internally (two legs);
    // otherwise it's treated as an external payout (one leg, like a wire).
    const toAccount = await prisma.account.findUnique({ where: { accountNumber: toAccountNumber } });
    if (toAccount && toAccount.id === fromAccount.id) {
      throw new BadRequestError("Cannot schedule a transfer to the same account");
    }

    const schedule = await prisma.recurringTransfer.create({
      data: {
        companyId: req.companyId!,
        fromAccountId,
        toAccountNumber,
        amount,
        note,
        frequency,
        nextRunAt: startDate ? new Date(startDate) : new Date(),
        createdById: req.userId!,
      },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "RECURRING_TRANSFER_CREATED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "RecurringTransfer",
      targetId: schedule.id,
      metadata: { amount: amount.toString(), frequency, toAccountNumber },
    });

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
    const schedule = await prisma.recurringTransfer.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
    });
    if (!schedule) {
      throw new NotFoundError("Recurring transfer not found");
    }
    const updated = await prisma.recurringTransfer.update({
      where: { id: schedule.id },
      data: { active: parsed.data.active },
    });
    res.json({ schedule: updated });
  })
);

router.delete(
  "/recurring/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const schedule = await prisma.recurringTransfer.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
    });
    if (!schedule) {
      throw new NotFoundError("Recurring transfer not found");
    }
    await prisma.recurringTransfer.delete({ where: { id: schedule.id } });
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
    const { fromAccountId, amount, note, merchantCategory, otp } = parsed.data;

    if (!verifyOtp(otp)) {
      throw new UnprocessableEntityError("Invalid OTP. Use 8888 for this demo.");
    }

    let toAccountNumber = parsed.data.toAccountNumber;
    if (!toAccountNumber && parsed.data.qrPayload) {
      // Payload is either "HLBQR:<accountNumber>" or, when the merchant
      // requested a specific amount, "HLBQR:<accountNumber>|<amount>|<note>" —
      // only the account number segment is trusted server-side; the amount is
      // always taken from the request body, never from the scanned code.
      const match = /^HLBQR:(.+)$/.exec(parsed.data.qrPayload.trim());
      if (!match) {
        throw new BadRequestError("That QR code isn't a LamBank pay code");
      }
      toAccountNumber = match[1].split("|")[0];
    }
    if (!toAccountNumber) {
      throw new BadRequestError("Missing recipient account number");
    }

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
      throw new NotFoundError("Destination account number not found");
    }
    if (toAccount.id === fromAccount.id) {
      throw new BadRequestError("Cannot transfer to the same account");
    }
    if (!canDebit(fromAccount, amount)) {
      throw new UnprocessableEntityError("Insufficient balance");
    }

    const velocityCheck = await checkVelocity(req.companyId!, fromAccount.id);
    if (!velocityCheck.ok) {
      throw new TooManyRequestsError(velocityCheck.error);
    }

    const kybCheck = await checkTransactionAllowed(req.companyId!, amount);
    if (!kybCheck.allowed) {
      throw new ForbiddenError(kybCheck.message);
    }

    const description = note?.trim() || `Transfer to ${toAccount.accountNumber}`;
    const balanceBefore = Number(fromAccount.balance);

    const result = await prisma.$transaction(async (tx) => {
      await tx.account.update({
        where: { id: fromAccount.id },
        data: { balance: { decrement: amount } },
      });
      await tx.account.update({
        where: { id: toAccount.id },
        data: { balance: { increment: amount } },
      });
      await chargeOverdraftFeeIfNeeded(tx, fromAccount, balanceBefore, balanceBefore - amount);

      const debit = await tx.transaction.create({
        data: {
          accountId: fromAccount.id,
          amount,
          currency: fromAccount.currency,
          type: "DEBIT",
          description,
          category: "Transfer",
          merchant: toAccount.accountNumber,
          merchantCategory: merchantCategory || undefined,
        },
      });
      await tx.transaction.create({
        data: {
          accountId: toAccount.id,
          amount,
          currency: toAccount.currency,
          type: "CREDIT",
          description: note?.trim() || `Transfer from ${fromAccount.accountNumber}`,
          category: "Transfer",
          merchant: fromAccount.accountNumber,
          merchantCategory: merchantCategory || undefined,
        },
      });

      return debit;
    });

    await flagIfAnomalous(result.id, fromAccount.id, amount);

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "TRANSFER_COMPLETED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Transaction",
      targetId: result.id,
      metadata: { amount: amount.toString(), currency: fromAccount.currency, toAccountNumber: toAccount.accountNumber },
    });

    res.status(201).json({ transaction: result });
  })
);

// FX transfer: money leaves the bank entirely (recipient isn't necessarily a
// LamBank account), converted at a mock rate for display purposes.
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
    const { fromAccountId, targetCurrency, amount, recipientName, recipientAccount, note, merchantCategory, otp } = parsed.data;

    if (!verifyOtp(otp)) {
      throw new UnprocessableEntityError("Invalid OTP. Use 8888 for this demo.");
    }

    const fromAccount = await prisma.account.findFirst({
      where: { id: fromAccountId, companyId: req.companyId },
    });
    if (!fromAccount) {
      throw new NotFoundError("Source account not found");
    }
    if (fromAccount.frozen) {
      throw new LockedError("This account is frozen");
    }
    const tier = await getCompanyTier(req.companyId!);
    const plan = PLANS[tier];
    const { baseFeeAmount, discountAmount, feeAmount } = applyTransferDiscount(
      Math.round(((amount * FX_FEE_PCT) / 100) * 100) / 100,
      plan.transferDiscountPct
    );

    if (!canDebit(fromAccount, amount + feeAmount)) {
      throw new UnprocessableEntityError("Insufficient balance");
    }

    const fxVelocityCheck = await checkVelocity(req.companyId!, fromAccount.id);
    if (!fxVelocityCheck.ok) {
      throw new TooManyRequestsError(fxVelocityCheck.error);
    }

    const kybCheck = await checkTransactionAllowed(req.companyId!, amount);
    if (!kybCheck.allowed) {
      throw new ForbiddenError(kybCheck.message);
    }

    const convertedAmount = convertCurrency(amount, fromAccount.currency, targetCurrency);
    const description =
      (note?.trim() ? `${note.trim()} — ` : "") +
      `FX transfer to ${recipientName} (${recipientAccount}): ${convertedAmount.toFixed(2)} ${targetCurrency}`;
    const feeDescription =
      discountAmount > 0
        ? `FX transfer fee (${plan.transferDiscountPct}% ${plan.name} plan discount applied)`
        : "FX transfer fee";
    const fxBalanceBefore = Number(fromAccount.balance);

    const transaction = await prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id: fromAccount.id }, data: { balance: { decrement: amount } } });
      const debit = await tx.transaction.create({
        data: {
          accountId: fromAccount.id,
          amount,
          currency: fromAccount.currency,
          type: "DEBIT",
          description,
          category: "FX Transfer",
          merchant: `${recipientName} (${recipientAccount}) → ${targetCurrency}`,
          merchantCategory: merchantCategory || undefined,
        },
      });
      if (feeAmount > 0) {
        await tx.account.update({ where: { id: fromAccount.id }, data: { balance: { decrement: feeAmount } } });
        await tx.transaction.create({
          data: {
            accountId: fromAccount.id,
            amount: feeAmount,
            currency: fromAccount.currency,
            type: "DEBIT",
            description: feeDescription,
            category: "FX Transfer Fee",
            merchant: `${recipientName} (${recipientAccount}) → ${targetCurrency}`,
          },
        });
      }
      await chargeOverdraftFeeIfNeeded(tx, fromAccount, fxBalanceBefore, fxBalanceBefore - amount - feeAmount);
      return debit;
    });

    await flagIfAnomalous(transaction.id, fromAccount.id, amount);

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "FX_TRANSFER_COMPLETED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Transaction",
      targetId: transaction.id,
      metadata: {
        amount: amount.toString(),
        fromCurrency: fromAccount.currency,
        convertedAmount: convertedAmount.toFixed(2),
        targetCurrency,
        recipientName,
        recipientAccount,
        feeAmount: feeAmount.toString(),
        feeDiscountAmount: discountAmount.toString(),
      },
    });

    res.status(201).json({
      transaction,
      convertedAmount,
      targetCurrency,
      feeAmount,
      feePct: FX_FEE_PCT,
      baseFeeAmount,
      feeDiscountAmount: discountAmount,
      feeDiscountPct: plan.transferDiscountPct,
    });
  })
);

// Flat mock fee shown on wire transfers (display only, not deducted — same
// simplification as FX_FEE_PCT above). Wires move same-currency funds out to
// a bank outside LamBank, so there's no conversion involved, just a routing
// number/SWIFT code and (in this demo) a slower "arrives in 1-3 business
// days" framing on the frontend.
const WIRE_FEE_FLAT = 25;

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
    const { fromAccountId, bankName, routingNumber, recipientName, recipientAccount, amount, note, merchantCategory, otp } =
      parsed.data;

    if (!verifyOtp(otp)) {
      throw new UnprocessableEntityError("Invalid OTP. Use 8888 for this demo.");
    }

    const fromAccount = await prisma.account.findFirst({
      where: { id: fromAccountId, companyId: req.companyId },
    });
    if (!fromAccount) {
      throw new NotFoundError("Source account not found");
    }
    if (fromAccount.frozen) {
      throw new LockedError("This account is frozen");
    }
    const tier = await getCompanyTier(req.companyId!);
    const plan = PLANS[tier];
    const { baseFeeAmount, discountAmount, feeAmount } = applyTransferDiscount(WIRE_FEE_FLAT, plan.transferDiscountPct);

    if (!canDebit(fromAccount, amount + feeAmount)) {
      throw new UnprocessableEntityError("Insufficient balance");
    }

    const wireVelocityCheck = await checkVelocity(req.companyId!, fromAccount.id);
    if (!wireVelocityCheck.ok) {
      throw new TooManyRequestsError(wireVelocityCheck.error);
    }

    const kybCheck = await checkTransactionAllowed(req.companyId!, amount);
    if (!kybCheck.allowed) {
      throw new ForbiddenError(kybCheck.message);
    }

    const description =
      (note?.trim() ? `${note.trim()} — ` : "") +
      `Wire transfer to ${recipientName} (${recipientAccount}) at ${bankName}, routing ${routingNumber}`;
    const feeDescription =
      discountAmount > 0
        ? `Wire transfer fee (${plan.transferDiscountPct}% ${plan.name} plan discount applied)`
        : "Wire transfer fee";
    const wireBalanceBefore = Number(fromAccount.balance);

    const transaction = await prisma.$transaction(async (tx) => {
      await tx.account.update({ where: { id: fromAccount.id }, data: { balance: { decrement: amount } } });
      const debit = await tx.transaction.create({
        data: {
          accountId: fromAccount.id,
          amount,
          currency: fromAccount.currency,
          type: "DEBIT",
          description,
          category: "Wire Transfer",
          merchant: `${recipientName} (${recipientAccount}) @ ${bankName}`,
          merchantCategory: merchantCategory || undefined,
        },
      });
      if (feeAmount > 0) {
        await tx.account.update({ where: { id: fromAccount.id }, data: { balance: { decrement: feeAmount } } });
        await tx.transaction.create({
          data: {
            accountId: fromAccount.id,
            amount: feeAmount,
            currency: fromAccount.currency,
            type: "DEBIT",
            description: feeDescription,
            category: "Wire Transfer Fee",
            merchant: `${recipientName} (${recipientAccount}) @ ${bankName}`,
          },
        });
      }
      await chargeOverdraftFeeIfNeeded(tx, fromAccount, wireBalanceBefore, wireBalanceBefore - amount - feeAmount);
      return debit;
    });

    await flagIfAnomalous(transaction.id, fromAccount.id, amount);

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "WIRE_TRANSFER_COMPLETED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "Transaction",
      targetId: transaction.id,
      metadata: {
        amount: amount.toString(),
        currency: fromAccount.currency,
        bankName,
        routingNumber,
        recipientName,
        recipientAccount,
        feeAmount: feeAmount.toString(),
        feeDiscountAmount: discountAmount.toString(),
      },
    });

    res.status(201).json({
      transaction,
      feeAmount,
      baseFeeAmount,
      feeDiscountAmount: discountAmount,
      feeDiscountPct: plan.transferDiscountPct,
    });
  })
);

export default router;
