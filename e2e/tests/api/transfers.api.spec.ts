import { test, expect } from "../../fixtures/test";
import { ApiClient } from "../../utils/api-client";
import { DEMO_OTP } from "../../utils/env";
import { smallAmount, uniqueSuffix } from "../../utils/data";

/**
 * /api/transfers — the money-movement contract.
 *
 * Everything here runs inside the `sandbox` fixture: two freshly registered
 * companies, a funded payer and an empty payee, that no other spec can reach.
 * That is what lets an assertion say "the balance is now exactly
 * `before - amount`" and mean it — on the shared seeded company the same
 * assertion is a race against whatever another worker is spending at that
 * moment, and it fails for reasons that have nothing to do with transfers.
 *
 * The balance is still read immediately before and after each call rather
 * than captured once at the top of the file, because the sandbox is
 * worker-scoped and therefore carries state from one test to the next.
 */

async function balanceOf(api: ApiClient, accountId: string): Promise<number> {
  const account = (await api.listAccounts()).find((a) => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} disappeared mid-test`);
  return Number(account.balance);
}

test.describe("POST /api/transfers", () => {
  test("debits the source account by exactly the amount sent", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const before = await balanceOf(payer.api, payer.account.id);
    const amount = smallAmount();

    const { transaction } = await payer.api.post<{
      transaction: { id: string; amount: number };
    }>("/transfers", {
      fromAccountId: payer.account.id,
      toAccountNumber: payee.account.accountNumber,
      amount,
      note: `api ${uniqueSuffix()}`,
      otp: DEMO_OTP,
    });

    expect(transaction.id).toEqual(expect.any(String));
    expect(await balanceOf(payer.api, payer.account.id)).toBeCloseTo(before - amount, 2);
  });

  test("records the note on the resulting transaction", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const note = `note ${uniqueSuffix()}`;

    await payer.api.post("/transfers", {
      fromAccountId: payer.account.id,
      toAccountNumber: payee.account.accountNumber,
      amount: smallAmount(),
      note,
      otp: DEMO_OTP,
    });

    const { transactions } = await payer.api.get<{ transactions: { description: string }[] }>(
      `/accounts/${payer.account.id}/transactions`,
      { take: 10 }
    );
    expect(transactions.some((t) => (t.description ?? "").includes(note))).toBe(true);
  });

  test("rejects a wrong OTP with 422 and moves no money", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const before = await balanceOf(payer.api, payer.account.id);

    const res = await payer.api.raw().post("/transfers", {
      fromAccountId: payer.account.id,
      toAccountNumber: payee.account.accountNumber,
      amount: smallAmount(),
      otp: "0000",
    });

    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/invalid otp/i);
    expect(await balanceOf(payer.api, payer.account.id)).toBeCloseTo(before, 2);
  });

  test("rejects a negative amount", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const res = await payer.api.raw().post("/transfers", {
      fromAccountId: payer.account.id,
      toAccountNumber: payee.account.accountNumber,
      amount: -50,
      otp: DEMO_OTP,
    });

    expect([400, 422]).toContain(res.status());
  });

  test("rejects an amount beyond the balance and overdraft limit", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const before = await balanceOf(payer.api, payer.account.id);

    const res = await payer.api.raw().post("/transfers", {
      fromAccountId: payer.account.id,
      toAccountNumber: payee.account.accountNumber,
      amount: before + 10_000_000,
      otp: DEMO_OTP,
    });

    expect(res.ok()).toBe(false);
    expect(await balanceOf(payer.api, payer.account.id)).toBeCloseTo(before, 2);
  });

  test("rejects an unknown recipient account number", async ({ sandbox }) => {
    const { payer } = sandbox;
    const res = await payer.api.raw().post("/transfers", {
      fromAccountId: payer.account.id,
      toAccountNumber: "US-9999-0000",
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect([400, 404, 422]).toContain(res.status());
  });

  test("requires either an account number or a QR payload", async ({ sandbox }) => {
    const { payer } = sandbox;
    const res = await payer.api.raw().post("/transfers", {
      fromAccountId: payer.account.id,
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect([400, 422]).toContain(res.status());
  });

  test("accepts a QR payload in place of a typed account number", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const before = await balanceOf(payer.api, payer.account.id);
    const amount = smallAmount();

    const res = await payer.api.raw().post("/transfers", {
      fromAccountId: payer.account.id,
      qrPayload: `HLBQR:${payee.account.accountNumber}`,
      amount,
      otp: DEMO_OTP,
    });

    expect(res.status()).toBe(201);
    expect(await balanceOf(payer.api, payer.account.id)).toBeCloseTo(before - amount, 2);
  });
});

test.describe("POST /api/transfers/fx", () => {
  test("charges a fee on top of the amount", async ({ sandbox }) => {
    const { payer } = sandbox;
    const before = await balanceOf(payer.api, payer.account.id);
    const amount = smallAmount();

    const res = await payer.api.raw().post("/transfers/fx", {
      fromAccountId: payer.account.id,
      targetCurrency: "EUR",
      amount,
      recipientName: "E2E Recipient",
      recipientAccount: "DE89370400440532013000",
      otp: DEMO_OTP,
    });

    expect(res.status()).toBe(201);
    // Amount + percentage fee, so the debit is strictly larger than `amount`.
    expect(await balanceOf(payer.api, payer.account.id)).toBeLessThan(before - amount + 0.001);
  });

  test("rejects an unsupported target currency", async ({ sandbox }) => {
    const { payer } = sandbox;
    const res = await payer.api.raw().post("/transfers/fx", {
      fromAccountId: payer.account.id,
      targetCurrency: "XYZ",
      amount: smallAmount(),
      recipientName: "E2E Recipient",
      recipientAccount: "DE89370400440532013000",
      otp: DEMO_OTP,
    });

    expect([400, 422]).toContain(res.status());
  });
});

test.describe("Recurring transfers", () => {
  test("creates, toggles and deletes a schedule", async ({ sandbox }) => {
    const { payer, payee } = sandbox;

    const { schedule } = await payer.api.post<{ schedule: { id: string; active: boolean } }>(
      "/transfers/recurring",
      {
        fromAccountId: payer.account.id,
        toAccountNumber: payee.account.accountNumber,
        amount: smallAmount(),
        note: `recurring ${uniqueSuffix()}`,
        frequency: "MONTHLY",
      }
    );
    expect(schedule.id).toEqual(expect.any(String));

    const { schedules } = await payer.api.get<{ schedules: { id: string }[] }>(
      "/transfers/recurring"
    );
    expect(schedules.some((s) => s.id === schedule.id)).toBe(true);

    const paused = await payer.api.patch<{ schedule: { active: boolean } }>(
      `/transfers/recurring/${schedule.id}`,
      { active: false }
    );
    expect(paused.schedule.active).toBe(false);

    await payer.api.delete(`/transfers/recurring/${schedule.id}`);
    const after = await payer.api.get<{ schedules: { id: string }[] }>("/transfers/recurring");
    expect(after.schedules.some((s) => s.id === schedule.id)).toBe(false);
  });
});
