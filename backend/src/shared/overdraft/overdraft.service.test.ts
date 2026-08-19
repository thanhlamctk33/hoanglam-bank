import { describe, expect, it, vi } from "vitest";
import { canDebit, chargeOverdraftFeeIfNeeded, debitWithinOverdraftLimit } from "./overdraft.service";
import { OVERDRAFT_FEE } from "./overdraft.config";

const accountWith = (balance: number, overdraftLimit = 0) => ({ balance, overdraftLimit });

describe("canDebit", () => {
  it("allows a debit fully covered by the balance", () => {
    expect(canDebit(accountWith(1000), 250)).toBe(true);
  });

  it("allows a debit that lands exactly on zero", () => {
    expect(canDebit(accountWith(250), 250)).toBe(true);
  });

  it("rejects a debit past zero when no overdraft is allowed", () => {
    expect(canDebit(accountWith(250), 250.01)).toBe(false);
  });

  it("allows dipping into an approved overdraft", () => {
    expect(canDebit(accountWith(100, 500), 400)).toBe(true);
  });

  it("allows a debit landing exactly on the overdraft floor", () => {
    // 100 - 600 = -500, exactly the limit — still permitted.
    expect(canDebit(accountWith(100, 500), 600)).toBe(true);
  });

  it("rejects a debit one cent past the overdraft floor", () => {
    expect(canDebit(accountWith(100, 500), 600.01)).toBe(false);
  });

  it("still allows a debit from an already-negative balance with room left", () => {
    expect(canDebit(accountWith(-100, 500), 300)).toBe(true);
    expect(canDebit(accountWith(-100, 500), 500)).toBe(false);
  });

  it("coerces Prisma Decimal-like values rather than comparing strings", () => {
    // Prisma returns Decimal objects, not numbers — canDebit must not do
    // string comparison, which would rank "9" above "100".
    expect(canDebit({ balance: "100", overdraftLimit: "0" }, 9)).toBe(true);
    expect(canDebit({ balance: "100", overdraftLimit: "0" }, 900)).toBe(false);
  });
});

describe("chargeOverdraftFeeIfNeeded", () => {
  const mockTransactionClient = () => ({
    account: { update: vi.fn().mockResolvedValue(undefined) },
    transaction: { create: vi.fn().mockResolvedValue(undefined) },
  });

  const targetAccount = { id: "acc-1", currency: "USD" };

  it("charges the fee when a debit crosses from positive into negative", async () => {
    const tx = mockTransactionClient();
    await chargeOverdraftFeeIfNeeded(tx as never, targetAccount, 100, -50);

    expect(tx.account.update).toHaveBeenCalledTimes(1);
    expect(tx.account.update).toHaveBeenCalledWith({
      where: { id: "acc-1" },
      data: { balance: { decrement: OVERDRAFT_FEE } },
    });
    expect(tx.transaction.create).toHaveBeenCalledTimes(1);
    expect(tx.transaction.create.mock.calls[0][0].data).toMatchObject({
      accountId: "acc-1",
      amount: OVERDRAFT_FEE,
      type: "DEBIT",
      category: "Overdraft fee",
    });
  });

  it("does not charge when the account stays positive", async () => {
    const tx = mockTransactionClient();
    await chargeOverdraftFeeIfNeeded(tx as never, targetAccount, 100, 40);
    expect(tx.account.update).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });

  it("does not charge when the account lands exactly on zero", async () => {
    const tx = mockTransactionClient();
    await chargeOverdraftFeeIfNeeded(tx as never, targetAccount, 100, 0);
    expect(tx.account.update).not.toHaveBeenCalled();
  });

  it("does not charge twice when the account was already negative", async () => {
    // The fee is assessed once per time the account goes negative — a second
    // debit while already overdrawn must not stack another fee.
    const tx = mockTransactionClient();
    await chargeOverdraftFeeIfNeeded(tx as never, targetAccount, -50, -200);
    expect(tx.account.update).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });
});

describe("debitWithinOverdraftLimit", () => {
  // The guard's whole point is that the database — not JavaScript — decides
  // whether there's room, so these tests pin down how the function reads the
  // database's answer rather than re-testing the arithmetic in canDebit.
  const dbReturning = (rows: { balance: number }[]) => ({ $queryRaw: vi.fn().mockResolvedValue(rows) });

  it("reports success and the balance either side when the row was updated", async () => {
    const db = dbReturning([{ balance: 750 }]);

    const result = await debitWithinOverdraftLimit(db as never, "acc-1", 250);

    expect(result).toEqual({ ok: true, balanceBefore: 1000, balanceAfter: 750 });
  });

  it("reports failure when the UPDATE matched no row", async () => {
    // No row came back means the WHERE clause rejected the debit — someone
    // else spent the money between the caller's check and this write.
    const db = dbReturning([]);

    await expect(debitWithinOverdraftLimit(db as never, "acc-1", 250)).resolves.toEqual({ ok: false });
  });

  it("derives balanceBefore from the post-debit balance, not from a stale read", async () => {
    // A concurrent debit landed first, so the balance the caller saw earlier
    // is wrong; balanceBefore must be reconstructed from what the database
    // actually returned, or the overdraft fee would be charged on bad numbers.
    const db = dbReturning([{ balance: -50 }]);

    const result = await debitWithinOverdraftLimit(db as never, "acc-1", 100);

    expect(result).toEqual({ ok: true, balanceBefore: 50, balanceAfter: -50 });
  });

  it("coerces the Prisma Decimal the driver returns instead of concatenating it", async () => {
    // Prisma hands back Decimal objects; string maths here would turn
    // "750" + 250 into "750250".
    const db = dbReturning([{ balance: "750" } as never]);

    const result = await debitWithinOverdraftLimit(db as never, "acc-1", 250);

    expect(result).toEqual({ ok: true, balanceBefore: 1000, balanceAfter: 750 });
  });

  it("reports the crossing into negative that triggers an overdraft fee", async () => {
    const db = dbReturning([{ balance: -25 }]);

    const result = await debitWithinOverdraftLimit(db as never, "acc-1", 125);

    // Feeding these two into chargeOverdraftFeeIfNeeded must charge the fee.
    expect(result).toEqual({ ok: true, balanceBefore: 100, balanceAfter: -25 });
  });
});
