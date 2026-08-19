import { test, expect } from "@playwright/test";
import { ApiClient, Account } from "../../utils/api-client";
import { API_BASE_URL, DEMO_OTP, DEMO_USER, SECOND_USER } from "../../utils/env";
import { smallAmount, uniqueSuffix } from "../../utils/data";

/**
 * /api/payments — utility bill payments and QR Pay.
 *
 * Both are debit paths, so the shape of these specs mirrors transfers: prove
 * the happy path moves the exact amount, then prove every rejection path
 * leaves the balance untouched. A 400 that still took the money is worse than
 * a 500 that didn't.
 *
 * Amounts stay under $1,000 on purpose — that's UNVERIFIED_TRANSACTION_LIMIT
 * in kyb.config.ts, above which the KYB gate joins in and these specs would be
 * testing two rules at once.
 */

interface UtilityProvider {
  id: string;
  name: string;
  category: string;
}

interface Transaction {
  id: string;
  amount: number | string;
  type: "DEBIT" | "CREDIT";
  description: string;
  category: string;
  merchant: string;
}

interface QrCode {
  accountId: string;
  accountNumber: string;
  accountName: string;
  currency: string;
  requestedAmount: number | null;
  note: string | null;
  payload: string;
}

let client: ApiClient;
let recipient: ApiClient;

test.beforeAll(async () => {
  ({ client } = await ApiClient.login(DEMO_USER));
  // A second, unrelated company — the QR Pay counterparty.
  ({ client: recipient } = await ApiClient.login(SECOND_USER));
});

test.afterAll(async () => {
  await client.dispose();
  await recipient.dispose();
});

async function balanceOf(api: ApiClient, accountId: string): Promise<number> {
  const account = (await api.listAccounts()).find((a) => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} disappeared mid-test`);
  return Number(account.balance);
}

test.describe("GET /api/payments/utility/providers", () => {
  test("returns the biller catalogue", async () => {
    const { providers } = await client.get<{ providers: UtilityProvider[] }>(
      "/payments/utility/providers"
    );

    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(provider).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        category: expect.any(String),
      });
    }
    // The route's zod enum is built from this list, so the ids the client is
    // offered must be exactly the ids POST /utility will accept.
    expect(providers.map((p) => p.id)).toContain("evn");
  });

  test("401s without a token", async ({ request }) => {
    const res = await request.get(`${API_BASE_URL}/payments/utility/providers`);
    expect(res.status()).toBe(401);
  });
});

test.describe("POST /api/payments/utility", () => {
  test("debits the account and books the payment against the provider", async () => {
    const account = await client.firstAccount("USD");
    const before = await balanceOf(client, account.id);
    const amount = smallAmount();
    const customerCode = `PE${uniqueSuffix()}`;

    const result = await client.post<{
      transaction: Transaction;
      originalAmount: number;
      discountAmount: number;
      amountCharged: number;
    }>("/payments/utility", {
      accountId: account.id,
      providerId: "evn",
      customerCode,
      amount,
    });

    expect(result.originalAmount).toBeCloseTo(amount, 2);
    expect(await balanceOf(client, account.id)).toBeCloseTo(before - result.amountCharged, 2);

    const tx = result.transaction;
    expect(tx.type).toBe("DEBIT");
    expect(tx.merchant).toBe("EVN - Electricity");
    expect(tx.category).toBe("Electricity");
    // The customer code has to survive into the ledger, or the payment can't
    // be reconciled with the biller later.
    expect(tx.description).toContain(customerCode);
  });

  test("the plan discount matches the company's current tier", async () => {
    const { plan } = await client.get<{ plan: { spendDiscountPct: number } }>("/subscription");
    const account = await client.firstAccount("USD");
    const amount = 100;

    const result = await client.post<{
      originalAmount: number;
      discountAmount: number;
      amountCharged: number;
    }>("/payments/utility", {
      accountId: account.id,
      providerId: "fpt",
      customerCode: `PE${uniqueSuffix()}`,
      amount,
    });

    const expectedDiscount = Math.round(amount * (plan.spendDiscountPct / 100) * 100) / 100;
    expect(result.discountAmount).toBeCloseTo(expectedDiscount, 2);
    expect(result.amountCharged).toBeCloseTo(amount - expectedDiscount, 2);
  });

  test("rejects an unknown provider id", async () => {
    const account = await client.firstAccount("USD");
    const before = await balanceOf(client, account.id);

    const res = await client.raw().post("/payments/utility", {
      accountId: account.id,
      providerId: "not-a-real-biller",
      customerCode: "PE123",
      amount: smallAmount(),
    });

    expect([400, 422]).toContain(res.status());
    expect(await balanceOf(client, account.id)).toBeCloseTo(before, 2);
  });

  test("rejects a non-positive amount", async () => {
    const account = await client.firstAccount("USD");

    for (const amount of [0, -25]) {
      const res = await client.raw().post("/payments/utility", {
        accountId: account.id,
        providerId: "evn",
        customerCode: "PE123",
        amount,
      });
      expect([400, 422], `amount ${amount} must be refused`).toContain(res.status());
    }
  });

  test("rejects an empty customer code", async () => {
    const account = await client.firstAccount("USD");

    const res = await client.raw().post("/payments/utility", {
      accountId: account.id,
      providerId: "evn",
      customerCode: "",
      amount: smallAmount(),
    });

    expect([400, 422]).toContain(res.status());
  });

  test("refuses to pay from another company's account", async () => {
    const foreign: Account = await recipient.firstAccount();
    const before = await balanceOf(recipient, foreign.id);

    const res = await client.raw().post("/payments/utility", {
      accountId: foreign.id,
      providerId: "evn",
      customerCode: `PE${uniqueSuffix()}`,
      amount: smallAmount(),
    });

    expect(res.status(), "an account id from another tenant must 404").toBe(404);
    expect(await balanceOf(recipient, foreign.id)).toBeCloseTo(before, 2);
  });

  test("refuses an amount beyond the available balance", async () => {
    const account = await client.firstAccount("USD");
    const before = await balanceOf(client, account.id);

    const res = await client.raw().post("/payments/utility", {
      accountId: account.id,
      providerId: "evn",
      customerCode: `PE${uniqueSuffix()}`,
      amount: before + 500_000,
    });

    expect(res.ok()).toBe(false);
    expect(await balanceOf(client, account.id)).toBeCloseTo(before, 2);
  });
});

test.describe("GET /api/payments/qr/my-code", () => {
  test("returns a bare pay code for the default account", async () => {
    const code = await client.get<QrCode>("/payments/qr/my-code");

    expect(code.payload).toBe(`HLBQR:${code.accountNumber}`);
    expect(code.requestedAmount).toBeNull();
    expect(code.note).toBeNull();
  });

  test("encodes a requested amount and note into the payload", async () => {
    const account = await client.firstAccount("USD");
    const note = `Table 7 ${uniqueSuffix()}`;

    const code = await client.get<QrCode>("/payments/qr/my-code", {
      accountId: account.id,
      amount: 42.5,
      note,
    });

    expect(code.accountId).toBe(account.id);
    expect(code.requestedAmount).toBe(42.5);
    expect(code.payload).toBe(`HLBQR:${account.accountNumber}|42.5|${encodeURIComponent(note)}`);
  });

  test("escapes a pipe in the note so the payload stays parseable", async () => {
    const account = await client.firstAccount("USD");

    const code = await client.get<QrCode>("/payments/qr/my-code", {
      accountId: account.id,
      amount: 10,
      note: "a|b",
    });

    // Three fields, not four — the note's own "|" must not become a separator.
    expect(code.payload.split("|")).toHaveLength(3);
    expect(code.payload.endsWith("a%7Cb")).toBe(true);
  });

  test("cannot mint a code for another company's account", async () => {
    const foreign = await recipient.firstAccount();

    const res = await client.raw().get("/payments/qr/my-code", { accountId: foreign.id });
    expect(res.status()).toBe(404);
  });
});

test.describe("POST /api/payments/qr/pay", () => {
  test("moves money from the payer to the code's owner", async () => {
    const source = await client.firstAccount("USD");
    const payeeCode = await recipient.get<QrCode>("/payments/qr/my-code");

    const payerBefore = await balanceOf(client, source.id);
    const payeeBefore = await balanceOf(recipient, payeeCode.accountId);
    const amount = smallAmount();
    const note = `QR ${uniqueSuffix()}`;

    const { transaction } = await client.post<{ transaction: Transaction }>("/payments/qr/pay", {
      fromAccountId: source.id,
      payload: payeeCode.payload,
      amount,
      note,
      otp: DEMO_OTP,
    });

    expect(transaction.type).toBe("DEBIT");
    expect(transaction.category).toBe("QR Pay");
    // Both sides of the ledger must move, and by the same amount.
    expect(await balanceOf(client, source.id)).toBeCloseTo(payerBefore - amount, 2);
    expect(await balanceOf(recipient, payeeCode.accountId)).toBeCloseTo(payeeBefore + amount, 2);
  });

  test("writes a matching CREDIT on the receiving account", async () => {
    const source = await client.firstAccount("USD");
    const payeeCode = await recipient.get<QrCode>("/payments/qr/my-code");
    const note = `QR credit ${uniqueSuffix()}`;
    const amount = smallAmount();

    await client.post("/payments/qr/pay", {
      fromAccountId: source.id,
      payload: payeeCode.payload,
      amount,
      note,
      otp: DEMO_OTP,
    });

    const { transactions } = await recipient.get<{ transactions: Transaction[] }>(
      `/accounts/${payeeCode.accountId}/transactions`,
      { take: 10 }
    );
    const credit = transactions.find((t) => t.description === note);
    expect(credit, "the payee sees the payment arrive").toBeTruthy();
    expect(credit!.type).toBe("CREDIT");
    expect(Number(credit!.amount)).toBeCloseTo(amount, 2);
  });

  test("rejects a wrong OTP and moves nothing", async () => {
    const source = await client.firstAccount("USD");
    const payeeCode = await recipient.get<QrCode>("/payments/qr/my-code");
    const before = await balanceOf(client, source.id);

    const res = await client.raw().post("/payments/qr/pay", {
      fromAccountId: source.id,
      payload: payeeCode.payload,
      amount: smallAmount(),
      otp: "0000",
    });

    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/invalid otp/i);
    expect(await balanceOf(client, source.id)).toBeCloseTo(before, 2);
  });

  test("rejects a payload that isn't a LamBank pay code", async () => {
    const source = await client.firstAccount("USD");

    const res = await client.raw().post("/payments/qr/pay", {
      fromAccountId: source.id,
      payload: "https://evil.example.com/pay?to=attacker",
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid qr code/i);
  });

  test("rejects a well-formed code for an account that doesn't exist", async () => {
    const source = await client.firstAccount("USD");

    const res = await client.raw().post("/payments/qr/pay", {
      fromAccountId: source.id,
      payload: "HLBQR:US-9999-0000",
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect(res.status()).toBe(404);
  });

  test("refuses a payment to yourself", async () => {
    const ownCode = await client.get<QrCode>("/payments/qr/my-code");
    const before = await balanceOf(client, ownCode.accountId);

    const res = await client.raw().post("/payments/qr/pay", {
      fromAccountId: ownCode.accountId,
      payload: ownCode.payload,
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/cannot pay yourself/i);
    expect(await balanceOf(client, ownCode.accountId)).toBeCloseTo(before, 2);
  });

  test("refuses to pay out of an account the caller doesn't own", async () => {
    const foreign = await recipient.firstAccount();
    const before = await balanceOf(recipient, foreign.id);
    const ownCode = await client.get<QrCode>("/payments/qr/my-code");

    const res = await client.raw().post("/payments/qr/pay", {
      fromAccountId: foreign.id,
      payload: ownCode.payload,
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect(res.status(), "the payer must own the source account").toBe(404);
    expect(await balanceOf(recipient, foreign.id)).toBeCloseTo(before, 2);
  });

  test("refuses an amount beyond the available balance", async () => {
    const source = await client.firstAccount("USD");
    const payeeCode = await recipient.get<QrCode>("/payments/qr/my-code");
    const before = await balanceOf(client, source.id);

    const res = await client.raw().post("/payments/qr/pay", {
      fromAccountId: source.id,
      payload: payeeCode.payload,
      amount: before + 500_000,
      otp: DEMO_OTP,
    });

    expect(res.ok()).toBe(false);
    expect(await balanceOf(client, source.id)).toBeCloseTo(before, 2);
  });

  test("rejects a non-positive amount", async () => {
    const source = await client.firstAccount("USD");
    const payeeCode = await recipient.get<QrCode>("/payments/qr/my-code");

    const res = await client.raw().post("/payments/qr/pay", {
      fromAccountId: source.id,
      payload: payeeCode.payload,
      amount: -10,
      otp: DEMO_OTP,
    });

    expect([400, 422]).toContain(res.status());
  });
});
