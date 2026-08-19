import {
  BadRequestError,
  ForbiddenError,
  LockedError,
  NotFoundError,
  TooManyRequestsError,
  UnprocessableEntityError,
} from "../../../errors/AppError";
import { checkTransactionAllowed } from "../../compliance/kyb/kyb.service";
import { writeAuditLog, resolveActorEmail } from "../../../shared/audit/audit.service";
import { canDebit, chargeOverdraftFeeIfNeeded, debitWithinOverdraftLimit } from "../../../shared/overdraft/overdraft.service";
import { checkVelocity, flagIfAnomalous } from "../../../shared/fraud/fraud.service";
import * as billsRepo from "./bills.repository";

/**
 * Business logic for bills — every route in bills.routes.ts is a thin
 * validate-then-call-this wrapper. All Prisma access goes through
 * bills.repository.ts.
 */

/** Loads a company's own bill, or throws 404. */
async function requireOwnBill(companyId: string, id: string) {
  const bill = await billsRepo.findOwnBill(companyId, id);
  if (!bill) {
    throw new NotFoundError("Bill not found");
  }
  return bill;
}

// There's no background worker in this app, so scheduled money movements
// (this, and recurring transfers in transfers.service.ts) run lazily:
// whenever the relevant list is fetched, anything due gets processed first.
// Failures are skipped quietly (left for the next visit) rather than
// surfaced as errors, since there's no active request/user to show them to.
export async function processDueAutopayBills(companyId: string) {
  const due = await billsRepo.findDueAutopayBills(companyId);

  for (const bill of due) {
    const account = await billsRepo.findAccountById(bill.autopayAccountId!);
    if (!account || account.companyId !== companyId) continue;
    if (account.frozen) continue;
    if (account.currency !== bill.currency) continue;

    const amount = Number(bill.amount);
    if (!canDebit(account, amount)) continue;

    const kybCheck = await checkTransactionAllowed(companyId, amount);
    if (!kybCheck.allowed) continue;

    // An interactive transaction rather than a batch of independent writes:
    // the debit is guarded against the account being drained since the
    // canDebit() check above, and that guard has to be able to abandon the
    // rest of this bill.
    const paidSuccessfully = await billsRepo.runInTransaction(async (tx) => {
      const debitResult = await debitWithinOverdraftLimit(tx, account.id, amount);
      if (!debitResult.ok) {
        return false;
      }

      await billsRepo.updateBillStatus(bill.id, "PAID", tx);
      await billsRepo.createTransactionRecord(
        {
          accountId: account.id,
          amount,
          currency: account.currency,
          type: "DEBIT",
          description: `Bill autopay — ${bill.vendor}`,
          category: "Bill Payment",
          merchant: bill.vendor,
        },
        tx
      );
      await chargeOverdraftFeeIfNeeded(tx, account, debitResult.balanceBefore, debitResult.balanceAfter);
      return true;
    });

    // Someone else spent the money first — leave the bill unpaid and let the
    // next autopay run try again, same as the checks above do.
    if (!paidSuccessfully) continue;

    await writeAuditLog({
      action: "BILL_AUTOPAID",
      actorEmail: "system:autopay",
      targetType: "Bill",
      targetId: bill.id,
      metadata: { vendor: bill.vendor, amount: amount.toString() },
    });
  }
}

export async function listBills(companyId: string) {
  await processDueAutopayBills(companyId);
  return billsRepo.findBillsByCompany(companyId);
}

export interface CreateBillParams {
  vendor: string;
  amount: number;
  currency: string;
  dueDate: string;
}

export function createBill(companyId: string, params: CreateBillParams) {
  return billsRepo.createBill({
    vendor: params.vendor,
    amount: params.amount,
    currency: params.currency,
    dueDate: new Date(params.dueDate),
    companyId,
  });
}

export async function setAutopayAccount(companyId: string, billId: string, accountId: string | null, userId: string) {
  const bill = await requireOwnBill(companyId, billId);

  if (accountId) {
    const account = await billsRepo.findOwnAccount(companyId, accountId);
    if (!account) {
      throw new NotFoundError("Account not found");
    }
    if (account.currency !== bill.currency) {
      throw new BadRequestError(`Choose an account in ${bill.currency} for autopay`);
    }
  }

  const updated = await billsRepo.updateBillAutopayAccount(bill.id, accountId);

  await writeAuditLog({
    action: accountId ? "BILL_AUTOPAY_ENABLED" : "BILL_AUTOPAY_DISABLED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Bill",
    targetId: bill.id,
    metadata: { vendor: bill.vendor },
  });

  return updated;
}

// Marking a bill PAID is a real money movement — it debits a company
// account and writes a Transaction, same as every other payment flow in the
// app. Any other status is just a flag flip with no financial effect.
export async function setBillStatus(
  companyId: string,
  billId: string,
  status: "UNPAID" | "PAID" | "OVERDUE",
  accountId: string | undefined,
  userId: string
) {
  const bill = await requireOwnBill(companyId, billId);

  if (status !== "PAID") {
    return billsRepo.updateBillStatus(bill.id, status);
  }

  if (bill.status === "PAID") {
    throw new BadRequestError("This bill is already paid");
  }
  if (!accountId) {
    throw new BadRequestError("Choose an account to pay this bill from");
  }

  const account = await billsRepo.findOwnAccount(companyId, accountId);
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

  const velocityCheck = await checkVelocity(companyId, account.id);
  if (!velocityCheck.ok) {
    throw new TooManyRequestsError(velocityCheck.error);
  }

  const kybCheck = await checkTransactionAllowed(companyId, amount);
  if (!kybCheck.allowed) {
    throw new ForbiddenError(kybCheck.message);
  }

  const [updated, paymentTransaction] = await billsRepo.runInTransaction(async (tx) => {
    const debitResult = await debitWithinOverdraftLimit(tx, account.id, amount);
    if (!debitResult.ok) {
      throw new UnprocessableEntityError("Insufficient balance");
    }
    const updatedBill = await billsRepo.updateBillStatus(bill.id, "PAID", tx);
    const created = await billsRepo.createTransactionRecord(
      {
        accountId: account.id,
        amount,
        currency: account.currency,
        type: "DEBIT",
        description: `Bill payment — ${bill.vendor}`,
        category: "Bill Payment",
        merchant: bill.vendor,
      },
      tx
    );
    await chargeOverdraftFeeIfNeeded(tx, account, debitResult.balanceBefore, debitResult.balanceAfter);
    return [updatedBill, created] as const;
  });

  await flagIfAnomalous(paymentTransaction.id, account.id, amount);

  await writeAuditLog({
    action: "BILL_PAID",
    actorEmail: await resolveActorEmail(userId),
    targetType: "Bill",
    targetId: bill.id,
    metadata: { vendor: bill.vendor, amount: amount.toString() },
  });

  return updated;
}

export async function deleteBill(companyId: string, billId: string) {
  const bill = await requireOwnBill(companyId, billId);
  await billsRepo.deleteBill(bill.id);
}
