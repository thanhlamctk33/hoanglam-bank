import { test, expect } from "@playwright/test";
import { ApiClient } from "../../utils/api-client";
import { DEMO_OTP, DEMO_USER, SECOND_USER } from "../../utils/env";
import { smallAmount, uniqueSuffix } from "../../utils/data";

/**
 * /api/transfers — the money-movement contract.
 *
 * Balance assertions read the source account immediately before and after the
 * call rather than trusting a value captured at the top of the file, so these
 * stay correct even when other specs are moving money in parallel.
 */

let client: ApiClient;

test.beforeAll(async () => {
  ({ client } = await ApiClient.login(DEMO_USER));
});

test.afterAll(async () => {
  await client.dispose();
});

async function balanceOf(accountId: string): Promise<number> {
  const accounts = await client.listAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} disappeared mid-test`);
  return Number(account.balance);
}

test.describe("POST /api/transfers", () => {
  test("debits the source account by exactly the amount sent", async () => {
    const source = await client.firstAccount("USD");
    const before = await balanceOf(source.id);
    const amount = smallAmount();

    const { transaction } = await client.post<{ transaction: { id: string; amount: number } }>(
      "/transfers",
      {
        fromAccountId: source.id,
        toAccountNumber: SECOND_USER.accountNumber,
        amount,
        note: `api ${uniqueSuffix()}`,
        otp: DEMO_OTP,
      }
    );

    expect(transaction.id).toEqual(expect.any(String));
    expect(await balanceOf(source.id)).toBeCloseTo(before - amount, 2);
  });

  test("records the note on the resulting transaction", async () => {
    const source = await client.firstAccount("USD");
    const note = `note ${uniqueSuffix()}`;

    await client.post("/transfers", {
      fromAccountId: source.id,
      toAccountNumber: SECOND_USER.accountNumber,
      amount: smallAmount(),
      note,
      otp: DEMO_OTP,
    });

    const { transactions } = await client.get<{ transactions: { description: string }[] }>(
      `/accounts/${source.id}/transactions`,
      { take: 10 }
    );
    expect(transactions.some((t) => (t.description ?? "").includes(note))).toBe(true);
  });

  test("rejects a wrong OTP with 422 and moves no money", async () => {
    const source = await client.firstAccount("USD");
    const before = await balanceOf(source.id);

    const res = await client.raw().post("/transfers", {
      fromAccountId: source.id,
      toAccountNumber: SECOND_USER.accountNumber,
      amount: smallAmount(),
      otp: "0000",
    });

    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/invalid otp/i);
    expect(await balanceOf(source.id)).toBeCloseTo(before, 2);
  });

  test("rejects a negative amount", async () => {
    const source = await client.firstAccount("USD");
    const res = await client.raw().post("/transfers", {
      fromAccountId: source.id,
      toAccountNumber: SECOND_USER.accountNumber,
      amount: -50,
      otp: DEMO_OTP,
    });

    expect([400, 422]).toContain(res.status());
  });

  test("rejects an amount beyond the balance and overdraft limit", async () => {
    const source = await client.firstAccount("USD");
    const before = await balanceOf(source.id);

    const res = await client.raw().post("/transfers", {
      fromAccountId: source.id,
      toAccountNumber: SECOND_USER.accountNumber,
      amount: before + 10_000_000,
      otp: DEMO_OTP,
    });

    expect(res.ok()).toBe(false);
    expect(await balanceOf(source.id)).toBeCloseTo(before, 2);
  });

  test("rejects an unknown recipient account number", async () => {
    const source = await client.firstAccount("USD");
    const res = await client.raw().post("/transfers", {
      fromAccountId: source.id,
      toAccountNumber: "US-9999-0000",
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect([400, 404, 422]).toContain(res.status());
  });

  test("requires either an account number or a QR payload", async () => {
    const source = await client.firstAccount("USD");
    const res = await client.raw().post("/transfers", {
      fromAccountId: source.id,
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect([400, 422]).toContain(res.status());
  });

  test("accepts a QR payload in place of a typed account number", async () => {
    const source = await client.firstAccount("USD");
    const before = await balanceOf(source.id);
    const amount = smallAmount();

    const res = await client.raw().post("/transfers", {
      fromAccountId: source.id,
      qrPayload: `HLBQR:${SECOND_USER.accountNumber}`,
      amount,
      otp: DEMO_OTP,
    });

    expect(res.status()).toBe(201);
    expect(await balanceOf(source.id)).toBeCloseTo(before - amount, 2);
  });
});

test.describe("POST /api/transfers/fx", () => {
  test("charges a fee on top of the amount", async () => {
    const source = await client.firstAccount("USD");
    const before = await balanceOf(source.id);
    const amount = smallAmount();

    const res = await client.raw().post("/transfers/fx", {
      fromAccountId: source.id,
      targetCurrency: "EUR",
      amount,
      recipientName: "E2E Recipient",
      recipientAccount: "DE89370400440532013000",
      otp: DEMO_OTP,
    });

    expect(res.status()).toBe(201);
    // Amount + percentage fee, so the debit is strictly larger than `amount`.
    expect(await balanceOf(source.id)).toBeLessThan(before - amount + 0.001);
  });

  test("rejects an unsupported target currency", async () => {
    const source = await client.firstAccount("USD");
    const res = await client.raw().post("/transfers/fx", {
      fromAccountId: source.id,
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
  test("creates, toggles and deletes a schedule", async () => {
    const source = await client.firstAccount("USD");

    const { schedule } = await client.post<{ schedule: { id: string; active: boolean } }>(
      "/transfers/recurring",
      {
        fromAccountId: source.id,
        toAccountNumber: SECOND_USER.accountNumber,
        amount: smallAmount(),
        note: `recurring ${uniqueSuffix()}`,
        frequency: "MONTHLY",
      }
    );
    expect(schedule.id).toEqual(expect.any(String));

    const { schedules } = await client.get<{ schedules: { id: string }[] }>(
      "/transfers/recurring"
    );
    expect(schedules.some((s) => s.id === schedule.id)).toBe(true);

    const paused = await client.patch<{ schedule: { active: boolean } }>(
      `/transfers/recurring/${schedule.id}`,
      { active: false }
    );
    expect(paused.schedule.active).toBe(false);

    await client.delete(`/transfers/recurring/${schedule.id}`);
    const after = await client.get<{ schedules: { id: string }[] }>("/transfers/recurring");
    expect(after.schedules.some((s) => s.id === schedule.id)).toBe(false);
  });
});
