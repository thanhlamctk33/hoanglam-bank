import { test, expect } from "../../fixtures/test";
import { ApiClient } from "../../utils/api-client";
import { DEMO_OTP } from "../../utils/env";
import { smallAmount, uniqueSuffix } from "../../utils/data";

/**
 * /api/payments — utility bill payments and QR Pay.
 *
 * Both are debit paths, so the shape of these specs mirrors transfers: prove
 * the happy path moves the exact amount, then prove every rejection path
 * leaves the balance untouched. A 400 that still took the money is worse than
 * a 500 that didn't.
 *
 * Anything that does arithmetic on a balance runs inside the `sandbox`
 * fixture — `payer` and `payee` are two freshly registered companies nothing
 * else in the suite can see. `payee` doubles as the "not your account"
 * subject in the negative tests, which is why those can assert that its
 * balance is untouched and mean it.
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

async function balanceOf(api: ApiClient, accountId: string): Promise<number> {
  const account = (await api.listAccounts()).find((a) => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} disappeared mid-test`);
  return Number(account.balance);
}

test.describe("GET /api/payments/utility/providers", () => {
  test("returns the biller catalogue", async ({ adminApi }) => {
    const { providers } = await adminApi.get<{ providers: UtilityProvider[] }>(
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

  test("401s without a token", async ({ anonApi }) => {
    const res = await anonApi.raw().get("/payments/utility/providers");
    expect(res.status()).toBe(401);
  });
});

test.describe("POST /api/payments/utility", () => {
  test("debits the account and books the payment against the provider", async ({ sandbox }) => {
    const { payer } = sandbox;
    const before = await balanceOf(payer.api, payer.account.id);
    const amount = smallAmount();
    const customerCode = `PE${uniqueSuffix()}`;

    const result = await payer.api.post<{
      transaction: Transaction;
      originalAmount: number;
      discountAmount: number;
      amountCharged: number;
    }>("/payments/utility", {
      accountId: payer.account.id,
      providerId: "evn",
      customerCode,
      amount,
    });

    expect(result.originalAmount).toBeCloseTo(amount, 2);
    expect(await balanceOf(payer.api, payer.account.id)).toBeCloseTo(
      before - result.amountCharged,
      2
    );

    const tx = result.transaction;
    expect(tx.type).toBe("DEBIT");
    expect(tx.merchant).toBe("EVN - Electricity");
    expect(tx.category).toBe("Electricity");
    // The customer code has to survive into the ledger, or the payment can't
    // be reconciled with the biller later.
    expect(tx.description).toContain(customerCode);
  });

  test("the plan discount matches the company's current tier", async ({ sandbox }) => {
    const { payer } = sandbox;
    const { plan } = await payer.api.get<{ plan: { spendDiscountPct: number } }>("/subscription");
    const amount = 100;

    const result = await payer.api.post<{
      originalAmount: number;
      discountAmount: number;
      amountCharged: number;
    }>("/payments/utility", {
      accountId: payer.account.id,
      providerId: "fpt",
      customerCode: `PE${uniqueSuffix()}`,
      amount,
    });

    const expectedDiscount = Math.round(amount * (plan.spendDiscountPct / 100) * 100) / 100;
    expect(result.discountAmount).toBeCloseTo(expectedDiscount, 2);
    expect(result.amountCharged).toBeCloseTo(amount - expectedDiscount, 2);
  });

  test("rejects an unknown provider id", async ({ sandbox }) => {
    const { payer } = sandbox;
    const before = await balanceOf(payer.api, payer.account.id);

    const res = await payer.api.raw().post("/payments/utility", {
      accountId: payer.account.id,
      providerId: "not-a-real-biller",
      customerCode: "PE123",
      amount: smallAmount(),
    });

    expect([400, 422]).toContain(res.status());
    expect(await balanceOf(payer.api, payer.account.id)).toBeCloseTo(before, 2);
  });

  test("rejects a non-positive amount", async ({ sandbox }) => {
    const { payer } = sandbox;

    for (const amount of [0, -25]) {
      const res = await payer.api.raw().post("/payments/utility", {
        accountId: payer.account.id,
        providerId: "evn",
        customerCode: "PE123",
        amount,
      });
      expect([400, 422], `amount ${amount} must be refused`).toContain(res.status());
    }
  });

  test("rejects an empty customer code", async ({ sandbox }) => {
    const { payer } = sandbox;

    const res = await payer.api.raw().post("/payments/utility", {
      accountId: payer.account.id,
      providerId: "evn",
      customerCode: "",
      amount: smallAmount(),
    });

    expect([400, 422]).toContain(res.status());
  });

  test("refuses to pay from another company's account", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const before = await balanceOf(payee.api, payee.account.id);

    const res = await payer.api.raw().post("/payments/utility", {
      accountId: payee.account.id,
      providerId: "evn",
      customerCode: `PE${uniqueSuffix()}`,
      amount: smallAmount(),
    });

    expect(res.status(), "an account id from another tenant must 404").toBe(404);
    expect(await balanceOf(payee.api, payee.account.id)).toBeCloseTo(before, 2);
  });

  test("refuses an amount beyond the available balance", async ({ sandbox }) => {
    const { payer } = sandbox;
    const before = await balanceOf(payer.api, payer.account.id);

    const res = await payer.api.raw().post("/payments/utility", {
      accountId: payer.account.id,
      providerId: "evn",
      customerCode: `PE${uniqueSuffix()}`,
      amount: before + 500_000,
    });

    expect(res.ok()).toBe(false);
    expect(await balanceOf(payer.api, payer.account.id)).toBeCloseTo(before, 2);
  });
});

test.describe("GET /api/payments/qr/my-code", () => {
  test("returns a bare pay code for the default account", async ({ sandbox }) => {
    const code = await sandbox.payer.api.get<QrCode>("/payments/qr/my-code");

    expect(code.payload).toBe(`HLBQR:${code.accountNumber}`);
    expect(code.requestedAmount).toBeNull();
    expect(code.note).toBeNull();
  });

  test("encodes a requested amount and note into the payload", async ({ sandbox }) => {
    const { payer } = sandbox;
    const note = `Table 7 ${uniqueSuffix()}`;

    const code = await payer.api.get<QrCode>("/payments/qr/my-code", {
      accountId: payer.account.id,
      amount: 42.5,
      note,
    });

    expect(code.accountId).toBe(payer.account.id);
    expect(code.requestedAmount).toBe(42.5);
    expect(code.payload).toBe(
      `HLBQR:${payer.account.accountNumber}|42.5|${encodeURIComponent(note)}`
    );
  });

  test("escapes a pipe in the note so the payload stays parseable", async ({ sandbox }) => {
    const { payer } = sandbox;

    const code = await payer.api.get<QrCode>("/payments/qr/my-code", {
      accountId: payer.account.id,
      amount: 10,
      note: "a|b",
    });

    // Three fields, not four — the note's own "|" must not become a separator.
    expect(code.payload.split("|")).toHaveLength(3);
    expect(code.payload.endsWith("a%7Cb")).toBe(true);
  });

  test("cannot mint a code for another company's account", async ({ sandbox }) => {
    const { payer, payee } = sandbox;

    const res = await payer.api.raw().get("/payments/qr/my-code", {
      accountId: payee.account.id,
    });
    expect(res.status()).toBe(404);
  });
});

test.describe("POST /api/payments/qr/pay", () => {
  test("moves money from the payer to the code's owner", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const payeeCode = await payee.api.get<QrCode>("/payments/qr/my-code");

    const payerBefore = await balanceOf(payer.api, payer.account.id);
    const payeeBefore = await balanceOf(payee.api, payeeCode.accountId);
    const amount = smallAmount();
    const note = `QR ${uniqueSuffix()}`;

    const { transaction } = await payer.api.post<{ transaction: Transaction }>(
      "/payments/qr/pay",
      {
        fromAccountId: payer.account.id,
        payload: payeeCode.payload,
        amount,
        note,
        otp: DEMO_OTP,
      }
    );

    expect(transaction.type).toBe("DEBIT");
    expect(transaction.category).toBe("QR Pay");
    // Both sides of the ledger must move, and by the same amount.
    expect(await balanceOf(payer.api, payer.account.id)).toBeCloseTo(payerBefore - amount, 2);
    expect(await balanceOf(payee.api, payeeCode.accountId)).toBeCloseTo(payeeBefore + amount, 2);
  });

  test("writes a matching CREDIT on the receiving account", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const payeeCode = await payee.api.get<QrCode>("/payments/qr/my-code");
    const note = `QR credit ${uniqueSuffix()}`;
    const amount = smallAmount();

    await payer.api.post("/payments/qr/pay", {
      fromAccountId: payer.account.id,
      payload: payeeCode.payload,
      amount,
      note,
      otp: DEMO_OTP,
    });

    const { transactions } = await payee.api.get<{ transactions: Transaction[] }>(
      `/accounts/${payeeCode.accountId}/transactions`,
      { take: 10 }
    );
    const credit = transactions.find((t) => t.description === note);
    expect(credit, "the payee sees the payment arrive").toBeTruthy();
    expect(credit!.type).toBe("CREDIT");
    expect(Number(credit!.amount)).toBeCloseTo(amount, 2);
  });

  test("rejects a wrong OTP and moves nothing", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const payeeCode = await payee.api.get<QrCode>("/payments/qr/my-code");
    const before = await balanceOf(payer.api, payer.account.id);

    const res = await payer.api.raw().post("/payments/qr/pay", {
      fromAccountId: payer.account.id,
      payload: payeeCode.payload,
      amount: smallAmount(),
      otp: "0000",
    });

    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/invalid otp/i);
    expect(await balanceOf(payer.api, payer.account.id)).toBeCloseTo(before, 2);
  });

  test("rejects a payload that isn't a LamBank pay code", async ({ sandbox }) => {
    const { payer } = sandbox;

    const res = await payer.api.raw().post("/payments/qr/pay", {
      fromAccountId: payer.account.id,
      payload: "https://evil.example.com/pay?to=attacker",
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid qr code/i);
  });

  test("rejects a well-formed code for an account that doesn't exist", async ({ sandbox }) => {
    const { payer } = sandbox;

    const res = await payer.api.raw().post("/payments/qr/pay", {
      fromAccountId: payer.account.id,
      payload: "HLBQR:US-9999-0000",
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect(res.status()).toBe(404);
  });

  test("refuses a payment to yourself", async ({ sandbox }) => {
    const { payer } = sandbox;
    const ownCode = await payer.api.get<QrCode>("/payments/qr/my-code");
    const before = await balanceOf(payer.api, ownCode.accountId);

    const res = await payer.api.raw().post("/payments/qr/pay", {
      fromAccountId: ownCode.accountId,
      payload: ownCode.payload,
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/cannot pay yourself/i);
    expect(await balanceOf(payer.api, ownCode.accountId)).toBeCloseTo(before, 2);
  });

  test("refuses to pay out of an account the caller doesn't own", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const before = await balanceOf(payee.api, payee.account.id);
    const ownCode = await payer.api.get<QrCode>("/payments/qr/my-code");

    const res = await payer.api.raw().post("/payments/qr/pay", {
      fromAccountId: payee.account.id,
      payload: ownCode.payload,
      amount: smallAmount(),
      otp: DEMO_OTP,
    });

    expect(res.status(), "the payer must own the source account").toBe(404);
    expect(await balanceOf(payee.api, payee.account.id)).toBeCloseTo(before, 2);
  });

  test("refuses an amount beyond the available balance", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const payeeCode = await payee.api.get<QrCode>("/payments/qr/my-code");
    const before = await balanceOf(payer.api, payer.account.id);

    const res = await payer.api.raw().post("/payments/qr/pay", {
      fromAccountId: payer.account.id,
      payload: payeeCode.payload,
      amount: before + 500_000,
      otp: DEMO_OTP,
    });

    expect(res.ok()).toBe(false);
    expect(await balanceOf(payer.api, payer.account.id)).toBeCloseTo(before, 2);
  });

  test("rejects a non-positive amount", async ({ sandbox }) => {
    const { payer, payee } = sandbox;
    const payeeCode = await payee.api.get<QrCode>("/payments/qr/my-code");

    const res = await payer.api.raw().post("/payments/qr/pay", {
      fromAccountId: payer.account.id,
      payload: payeeCode.payload,
      amount: -10,
      otp: DEMO_OTP,
    });

    expect([400, 422]).toContain(res.status());
  });
});
