import { test, expect } from "../../fixtures/test";
import { Account } from "../../utils/api-client";
import { DEMO_OTP } from "../../utils/env";

/**
 * /api/accounts — the read side of the ledger, plus the tenancy boundary.
 * The isolation tests are the important ones here: they prove company A can't
 * read or move company B's money by guessing an id. `outsiderApi` is a company
 * registered fresh for each of those tests, so it shares nothing with the
 * seeded demo company by construction.
 */

test.describe("GET /api/accounts", () => {
  test("returns the caller's accounts with the expected shape", async ({ adminApi }) => {
    const accounts = await adminApi.listAccounts();

    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      expect(account).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        accountNumber: expect.any(String),
        currency: expect.any(String),
      });
      expect(Number.isFinite(Number(account.balance))).toBe(true);
    }
  });

  test("401s without a token", async ({ anonApi }) => {
    const res = await anonApi.raw().get("/accounts");
    expect(res.status()).toBe(401);
  });
});

test.describe("GET /api/accounts/:id/transactions", () => {
  test("paginates and respects the take limit", async ({ adminApi }) => {
    const account = await adminApi.firstAccount();
    const { transactions } = await adminApi.get<{ transactions: unknown[] }>(
      `/accounts/${account.id}/transactions`,
      { take: 5 }
    );

    expect(Array.isArray(transactions)).toBe(true);
    expect(transactions.length).toBeLessThanOrEqual(5);
  });

  test("filters by type", async ({ adminApi }) => {
    const account = await adminApi.firstAccount();
    const { transactions } = await adminApi.get<{ transactions: { type: string }[] }>(
      `/accounts/${account.id}/transactions`,
      { take: 25, type: "DEBIT" }
    );

    for (const tx of transactions) {
      expect(tx.type).toBe("DEBIT");
    }
  });
});

test.describe("GET /api/accounts/reports", () => {
  test("returns a monthly series and category breakdown", async ({ adminApi }) => {
    const reports = await adminApi.get<{ series?: unknown[]; categories?: unknown[] }>(
      "/accounts/reports",
      { months: 6 }
    );

    expect(reports).toBeTruthy();
    expect(Array.isArray(reports.series ?? [])).toBe(true);
    expect(Array.isArray(reports.categories ?? [])).toBe(true);
  });
});

test.describe("Tenancy isolation", () => {
  test("a fresh company cannot read another company's account", async ({
    adminApi,
    outsiderApi,
  }) => {
    const victimAccount: Account = await adminApi.firstAccount();

    // The id is valid — it just isn't theirs.
    const res = await outsiderApi.raw().get(`/accounts/${victimAccount.id}/transactions`);
    expect(
      [403, 404].includes(res.status()),
      `expected 403/404 for a cross-tenant read, got ${res.status()}`
    ).toBe(true);
  });

  test("a fresh company cannot transfer out of another company's account", async ({
    outsiderApi,
    sandbox,
  }) => {
    // The victim is the sandbox payer rather than the seeded company: this
    // test has to prove the balance did not move, and only an account nothing
    // else in the suite can touch makes that assertion trustworthy.
    const { payer, payee } = sandbox;
    const before = Number(
      (await payer.api.listAccounts()).find((a) => a.id === payer.account.id)!.balance
    );

    const res = await outsiderApi.raw().post("/transfers", {
      fromAccountId: payer.account.id,
      toAccountNumber: payee.account.accountNumber,
      amount: 1,
      otp: DEMO_OTP,
    });
    expect([403, 404]).toContain(res.status());

    const after = (await payer.api.listAccounts()).find((a) => a.id === payer.account.id);
    expect(Number(after!.balance)).toBeCloseTo(before, 2);
  });
});
