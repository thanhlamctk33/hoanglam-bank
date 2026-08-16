import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { BadRequestError, ForbiddenError, LockedError, NotFoundError, TooManyRequestsError, UnprocessableEntityError, ValidationError } from "../../errors/AppError";
import { checkTransactionAllowed } from "../kyb/kyb.service";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { canDebit, chargeOverdraftFeeIfNeeded } from "../../shared/overdraft/overdraft.service";
import { OVERDRAFT_FEE } from "../../shared/overdraft/overdraft.config";
import { checkVelocity, flagIfAnomalous } from "../../shared/fraud/fraud.service";

async function actorEmail(userId: string | undefined): Promise<string> {
  const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  return user?.email ?? "unknown";
}

const router = Router();
router.use(requireAuth);

// There's no background worker in this app, so scheduled money movements
// (this, and recurring transfers in transfers.ts) run lazily: whenever the
// relevant list is fetched, anything due gets processed first. Failures are
// skipped quietly (left for the next visit) rather than surfaced as errors,
// since there's no active request/user to show them to.
async function processDueAutopayBills(companyId: string) {
  const due = await prisma.bill.findMany({
    where: {
      companyId,
      status: { in: ["UNPAID", "OVERDUE"] },
      dueDate: { lte: new Date() },
      autopayAccountId: { not: null },
    },
  });

  for (const bill of due) {
    const account = await prisma.account.findUnique({ where: { id: bill.autopayAccountId! } });
    if (!account || account.companyId !== companyId) continue;
    if (account.frozen) continue;
    if (account.currency !== bill.currency) continue;

    const amount = Number(bill.amount);
    if (!canDebit(account, amount)) continue;

    const kybCheck = await checkTransactionAllowed(companyId, amount);
    if (!kybCheck.allowed) continue;

    const balanceBefore = Number(account.balance);
    const ops = [
      prisma.bill.update({ where: { id: bill.id }, data: { status: "PAID" } }),
      prisma.account.update({ where: { id: account.id }, data: { balance: { decrement: amount } } }),
      prisma.transaction.create({
        data: {
          accountId: account.id,
          amount,
          currency: account.currency,
          type: "DEBIT",
          description: `Bill autopay — ${bill.vendor}`,
          category: "Bill Payment",
          merchant: bill.vendor,
        },
      }),
    ];
    if (balanceBefore >= 0 && balanceBefore - amount < 0) {
      ops.push(
        prisma.account.update({ where: { id: account.id }, data: { balance: { decrement: OVERDRAFT_FEE } } }),
        prisma.transaction.create({
          data: {
            accountId: account.id,
            amount: OVERDRAFT_FEE,
            currency: account.currency,
            type: "DEBIT",
            description: "Overdraft fee",
            category: "Overdraft fee",
          },
        })
      );
    }
    await prisma.$transaction(ops);

    await writeAuditLog({
      action: "BILL_AUTOPAID",
      actorEmail: "system:autopay",
      targetType: "Bill",
      targetId: bill.id,
      metadata: { vendor: bill.vendor, amount: amount.toString() },
    });
  }
}

router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    await processDueAutopayBills(req.companyId!);
    const bills = await prisma.bill.findMany({
      where: { companyId: req.companyId },
      orderBy: { dueDate: "asc" },
    });
    res.json({ bills });
  })
);

const autopaySchema = z.object({
  accountId: z.string().uuid().nullable(),
});

router.patch(
  "/:id/autopay",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = autopaySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const bill = await prisma.bill.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!bill) {
      throw new NotFoundError("Bill not found");
    }

    if (parsed.data.accountId) {
      const account = await prisma.account.findFirst({
        where: { id: parsed.data.accountId, companyId: req.companyId },
      });
      if (!account) {
        throw new NotFoundError("Account not found");
      }
      if (account.currency !== bill.currency) {
        throw new BadRequestError(`Choose an account in ${bill.currency} for autopay`);
      }
    }

    const updated = await prisma.bill.update({
      where: { id: bill.id },
      data: { autopayAccountId: parsed.data.accountId },
    });

    await writeAuditLog({
      action: parsed.data.accountId ? "BILL_AUTOPAY_ENABLED" : "BILL_AUTOPAY_DISABLED",
      actorEmail: await actorEmail(req.userId),
      targetType: "Bill",
      targetId: bill.id,
      metadata: { vendor: bill.vendor },
    });

    res.json({ bill: updated });
  })
);

const createSchema = z.object({
  vendor: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().default("USD"),
  dueDate: z.string().datetime(),
});

router.post(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const bill = await prisma.bill.create({
      data: {
        vendor: parsed.data.vendor,
        amount: parsed.data.amount,
        currency: parsed.data.currency,
        dueDate: new Date(parsed.data.dueDate),
        companyId: req.companyId!,
      },
    });
    res.status(201).json({ bill });
  })
);

// Marking a bill PAID is a real money movement now — it debits a company
// account and writes a Transaction, same as every other payment flow in the
// app (previously this just flipped a status flag with no financial effect).
const statusSchema = z.object({
  status: z.enum(["UNPAID", "PAID", "OVERDUE"]),
  accountId: z.string().uuid().optional(),
});

router.patch(
  "/:id/status",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const bill = await prisma.bill.findFirst({
      where: { id: req.params.id, companyId: req.companyId },
    });
    if (!bill) {
      throw new NotFoundError("Bill not found");
    }

    if (parsed.data.status !== "PAID") {
      const updated = await prisma.bill.update({
        where: { id: bill.id },
        data: { status: parsed.data.status },
      });
      return res.json({ bill: updated });
    }

    if (bill.status === "PAID") {
      throw new BadRequestError("This bill is already paid");
    }
    if (!parsed.data.accountId) {
      throw new BadRequestError("Choose an account to pay this bill from");
    }

    const account = await prisma.account.findFirst({
      where: { id: parsed.data.accountId, companyId: req.companyId },
    });
    if (!account) {
      throw new NotFoundError("Account not found");
    }
    if (account.frozen) {
      throw new LockedError("This account is frozen");
    }
    if (account.currency !== bill.currency) {
      throw new BadRequestError(`Choose an account in ${bill.currency} to pay this bill`);
    }

    const amount = Number(bill.amount);
    if (!canDebit(account, amount)) {
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

    const [updated, paymentTransaction] = await prisma.$transaction(async (tx) => {
      const updatedBill = await tx.bill.update({ where: { id: bill.id }, data: { status: "PAID" } });
      const balanceBefore = Number(account.balance);
      await tx.account.update({ where: { id: account.id }, data: { balance: { decrement: amount } } });
      const created = await tx.transaction.create({
        data: {
          accountId: account.id,
          amount,
          currency: account.currency,
          type: "DEBIT",
          description: `Bill payment — ${bill.vendor}`,
          category: "Bill Payment",
          merchant: bill.vendor,
        },
      });
      await chargeOverdraftFeeIfNeeded(tx, account, balanceBefore, balanceBefore - amount);
      return [updatedBill, created];
    });

    await flagIfAnomalous(paymentTransaction.id, account.id, amount);

    await writeAuditLog({
      action: "BILL_PAID",
      actorEmail: await actorEmail(req.userId),
      targetType: "Bill",
      targetId: bill.id,
      metadata: { vendor: bill.vendor, amount: amount.toString() },
    });

    res.json({ bill: updated });
  })
);

router.delete(
  "/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const bill = await prisma.bill.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!bill) {
      throw new NotFoundError("Bill not found");
    }

    await prisma.bill.delete({ where: { id: bill.id } });
    res.status(204).end();
  })
);

export default router;
