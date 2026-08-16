import { describe, expect, it, vi } from "vitest";
import { canDebit, chargeOverdraftFeeIfNeeded } from "./overdraft.service";
import { OVERDRAFT_FEE } from "./overdraft.config";

const account = (balance: number, overdraftLimit = 0) => ({ balance, overdraftLimit });

describe("canDebit", () => {
  it("allows a debit fully covered by the balance", () => {
    expect(canDebit(account(1000), 250)).toBe(true);
  });

  it("allows a debit that lands exactly on zero", () => {
    expect(canDebit(account(250), 250)).toBe(true);
  });

  it("rejects a debit past zero when no overdraft is allowed", () => {
    expect(canDebit(account(250), 250.01)).toBe(false);
  });

  it("allows dipping into an approved overdraft", () => {
    expect(canDebit(account(100, 500), 400)).toBe(true);
  });

  it("allows a debit landing exactly on the overdraft floor", () => {
    // 100 - 600 = -500, exactly the limit — still permitted.
    expect(canDebit(account(100, 500), 600)).toBe(true);
  });

  it("rejects a debit one cent past the overdraft floor", () => {
    expect(canDebit(account(100, 500), 600.01)).toBe(false);
  });

  it("still allows a debit from an already-negative balance with room left", () => {
    expect(canDebit(account(-100, 500), 300)).toBe(true);
    expect(canDebit(account(-100, 500), 500)).toBe(false);
  });

  it("coerces Prisma Decimal-like values rather than comparing strings", () => {
    // Prisma returns Decimal objects, not numbers — canDebit must not do
    // string comparison, which would rank "9" above "100".
    expect(canDebit({ balance: "100", overdraftLimit: "0" }, 9)).toBe(true);
    expect(canDebit({ balance: "100", overdraftLimit: "0" }, 900)).toBe(false);
  });
});

describe("chargeOverdraftFeeIfNeeded", () => {
  const fakeTx = () => ({
    account: { update: vi.fn().mockResolvedValue(undefined) },
    transaction: { create: vi.fn().mockResolvedValue(undefined) },
  });

  const target = { id: "acc-1", currency: "USD" };

  it("charges the fee when a debit crosses from positive into negative", async () => {
    const tx = fakeTx();
    await chargeOverdraftFeeIfNeeded(tx as never, target, 100, -50);

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
    const tx = fakeTx();
    await chargeOverdraftFeeIfNeeded(tx as never, target, 100, 40);
    expect(tx.account.update).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });

  it("does not charge when the account lands exactly on zero", async () => {
    const tx = fakeTx();
    await chargeOverdraftFeeIfNeeded(tx as never, target, 100, 0);
    expect(tx.account.update).not.toHaveBeenCalled();
  });

  it("does not charge twice when the account was already negative", async () => {
    // The fee is assessed once per time the account goes negative — a second
    // debit while already overdrawn must not stack another fee.
    const tx = fakeTx();
    await chargeOverdraftFeeIfNeeded(tx as never, target, -50, -200);
    expect(tx.account.update).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });
});
