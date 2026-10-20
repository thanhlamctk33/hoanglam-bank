import { test, expect } from "../../fixtures/test";
import { ApiClient } from "../../utils/api-client";
import { uniqueSuffix } from "../../utils/data";

/**
 * /api/bills — vendor bills, and "Pay bill" as a real debit path.
 *
 * Paying a bill moves money exactly the way a transfer does: it debits a
 * chosen account and writes a Transaction. So this file follows the same
 * shape as transfers and payments — prove the happy path moves the exact
 * amount, then prove every refusal leaves the balance untouched.
 *
 * Amounts stay under $1,000 except where the KYB ceiling is the subject:
 * a freshly registered company is unverified, and above that limit the KYB
 * gate joins in (asserted explicitly at the bottom).
 */

interface Bill {
  id: string;
  vendor: string;
  amount: number | string;
  currency: string;
  status: "UNPAID" | "PAID" | "OVERDUE";
  autopayAccountId?: string | null;
}

interface LedgerRow {
  amount: number | string;
  type: "DEBIT" | "CREDIT";
  description: string;
}

const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

function newBillBody(overrides: Record<string, unknown> = {}) {
  return {
    vendor: `Vendor ${uniqueSuffix()}`,
    amount: 120,
    currency: "USD",
    dueDate: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    ...overrides,
  };
}

async function balanceOf(api: ApiClient, accountId: string): Promise<number> {
  const account = (await api.listAccounts()).find((a) => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} disappeared mid-test`);
  return Number(account.balance);
}

test.describe("POST /api/bills", () => {
  test("creates an unpaid bill", async ({ fundedCompany }) => {
    const { bill } = await fundedCompany.api.post<{ bill: Bill }>("/bills", newBillBody());

    expect(bill.status).toBe("UNPAID");
    expect(Number(bill.amount)).toBe(120);
  });

  test("rejects a bill with no vendor", async ({ fundedCompany }) => {
    const res = await fundedCompany.api.raw().post("/bills", newBillBody({ vendor: "" }));
    expect(res.status()).toBe(400);
  });

  test("rejects a due date that isn't a timestamp", async ({ fundedCompany }) => {
    const res = await fundedCompany.api.raw().post("/bills", newBillBody({ dueDate: "next week" }));
    expect(res.status()).toBe(400);
  });
});

test.describe("Paying a bill", () => {
  test("debits the chosen account by exactly the amount and writes a ledger row", async ({
    fundedCompany,
  }) => {
    const accountId = fundedCompany.account.id;
    const before = await balanceOf(fundedCompany.api, accountId);
    const { bill } = await fundedCompany.api.post<{ bill: Bill }>(
      "/bills",
      newBillBody({ amount: 250 })
    );

    const paid = await fundedCompany.api.patch<{ bill: Bill }>(`/bills/${bill.id}/status`, {
      status: "PAID",
      accountId,
    });
    expect(paid.bill.status).toBe("PAID");

    expect(await balanceOf(fundedCompany.api, accountId)).toBeCloseTo(before - 250, 2);

    const { transactions } = await fundedCompany.api.get<{ transactions: LedgerRow[] }>(
      `/accounts/${accountId}/transactions`,
      { take: 10 }
    );
    const debit = transactions.find(
      (row) => row.type === "DEBIT" && (row.description ?? "").includes(bill.vendor)
    );
    expect(debit, "paying a bill wrote a DEBIT naming the vendor").toBeTruthy();
    expect(Number(debit!.amount)).toBeCloseTo(250, 2);
  });

  test("a bill cannot be paid twice", async ({ fundedCompany }) => {
    const accountId = fundedCompany.account.id;
    const { bill } = await fundedCompany.api.post<{ bill: Bill }>(
      "/bills",
      newBillBody({ amount: 60 })
    );

    await fundedCompany.api.patch(`/bills/${bill.id}/status`, { status: "PAID", accountId });
    const before = await balanceOf(fundedCompany.api, accountId);

    const again = await fundedCompany.api
      .raw()
      .patch(`/bills/${bill.id}/status`, { status: "PAID", accountId });
    expect(again.status()).toBe(400);
    expect((await again.json()).error).toMatch(/already paid/i);

    expect(await balanceOf(fundedCompany.api, accountId)).toBeCloseTo(before, 2);
  });

  test("paying without naming an account is refused", async ({ fundedCompany }) => {
    const { bill } = await fundedCompany.api.post<{ bill: Bill }>("/bills", newBillBody());

    const res = await fundedCompany.api.raw().patch(`/bills/${bill.id}/status`, { status: "PAID" });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/choose an account/i);
  });

  test("an amount beyond the balance is refused and takes nothing", async ({ fundedCompany }) => {
    const accountId = fundedCompany.account.id;
    const before = await balanceOf(fundedCompany.api, accountId);
    const { bill } = await fundedCompany.api.post<{ bill: Bill }>(
      "/bills",
      newBillBody({ amount: before + 5000 })
    );

    const res = await fundedCompany.api
      .raw()
      .patch(`/bills/${bill.id}/status`, { status: "PAID", accountId });
    expect([403, 422]).toContain(res.status());

    expect(await balanceOf(fundedCompany.api, accountId)).toBeCloseTo(before, 2);
  });

  test("an account from another company cannot be used to pay", async ({
    fundedCompany,
    outsiderApi,
  }) => {
    const outsiderAccount = await outsiderApi.firstAccount("USD");
    const { bill } = await fundedCompany.api.post<{ bill: Bill }>("/bills", newBillBody());

    const res = await fundedCompany.api
      .raw()
      .patch(`/bills/${bill.id}/status`, { status: "PAID", accountId: outsiderAccount.id });
    expect(res.status()).toBe(404);
  });
});

test.describe("The KYB ceiling applies to bill payment too", () => {
  test("an unverified company cannot pay a bill above the limit", async ({ fundedCompany }) => {
    const accountId = fundedCompany.account.id;
    const before = await balanceOf(fundedCompany.api, accountId);
    // Comfortably above UNVERIFIED_TRANSACTION_LIMIT (1,000) and comfortably
    // within the balance, so the refusal can only be the KYB gate.
    const { bill } = await fundedCompany.api.post<{ bill: Bill }>(
      "/bills",
      newBillBody({ amount: 1500 })
    );

    const res = await fundedCompany.api
      .raw()
      .patch(`/bills/${bill.id}/status`, { status: "PAID", accountId });
    expect(res.status()).toBe(403);

    expect(await balanceOf(fundedCompany.api, accountId)).toBeCloseTo(before, 2);
  });
});

test.describe("Autopay is admin-only", () => {
  test("a MEMBER cannot arm autopay", async ({ memberApi }) => {
    const res = await memberApi.raw().patch(`/bills/${ABSENT_ID}/autopay`, {
      accountId: ABSENT_ID,
    });
    expect(res.status()).toBe(403);
  });

  test("an admin arms it, and can disarm it again", async ({ fundedCompany }) => {
    const { bill } = await fundedCompany.api.post<{ bill: Bill }>("/bills", newBillBody());

    const armed = await fundedCompany.api.patch<{ bill: Bill }>(`/bills/${bill.id}/autopay`, {
      accountId: fundedCompany.account.id,
    });
    expect(armed.bill.autopayAccountId).toBe(fundedCompany.account.id);

    const disarmed = await fundedCompany.api.patch<{ bill: Bill }>(`/bills/${bill.id}/autopay`, {
      accountId: null,
    });
    expect(disarmed.bill.autopayAccountId).toBeNull();
  });

  test("autopay refuses an account in the wrong currency", async ({ fundedCompany }) => {
    const { bill } = await fundedCompany.api.post<{ bill: Bill }>(
      "/bills",
      newBillBody({ currency: "EUR" })
    );

    const res = await fundedCompany.api
      .raw()
      .patch(`/bills/${bill.id}/autopay`, { accountId: fundedCompany.account.id });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/EUR/);
  });
});

test.describe("Company boundary", () => {
  test("an outside company sees none of these bills", async ({ fundedCompany, outsiderApi }) => {
    const { bill } = await fundedCompany.api.post<{ bill: Bill }>("/bills", newBillBody());

    const { bills } = await outsiderApi.get<{ bills: Bill[] }>("/bills");
    expect(bills.map((b) => b.id)).not.toContain(bill.id);
  });

  test("/bills refuses an anonymous caller", async ({ anonApi }) => {
    const res = await anonApi.raw().get("/bills");
    expect(res.status()).toBe(401);
  });
});
