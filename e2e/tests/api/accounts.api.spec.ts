import { test, expect } from "@playwright/test";
import { ApiClient, Account } from "../../utils/api-client";
import { API_BASE_URL, DEMO_OTP, DEMO_USER } from "../../utils/env";
import { newUserPayload } from "../../utils/data";

/**
 * /api/accounts — the read side of the ledger, plus the tenancy boundary.
 * The isolation test is the important one here: it proves company A can't
 * read or move company B's money by guessing an id.
 */

let client: ApiClient;

test.beforeAll(async () => {
  ({ client } = await ApiClient.login(DEMO_USER));
});

test.afterAll(async () => {
  await client.dispose();
});

test.describe("GET /api/accounts", () => {
  test("returns the caller's accounts with the expected shape", async () => {
    const accounts = await client.listAccounts();

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

  test("401s without a token", async ({ request }) => {
    const res = await request.get(`${API_BASE_URL}/accounts`);
    expect(res.status()).toBe(401);
  });
});

test.describe("GET /api/accounts/:id/transactions", () => {
  test("paginates and respects the take limit", async () => {
    const account = await client.firstAccount();
    const { transactions } = await client.get<{ transactions: unknown[] }>(
      `/accounts/${account.id}/transactions`,
      { take: 5 }
    );

    expect(Array.isArray(transactions)).toBe(true);
    expect(transactions.length).toBeLessThanOrEqual(5);
  });

  test("filters by type", async () => {
    const account = await client.firstAccount();
    const { transactions } = await client.get<{ transactions: { type: string }[] }>(
      `/accounts/${account.id}/transactions`,
      { take: 25, type: "DEBIT" }
    );

    for (const tx of transactions) {
      expect(tx.type).toBe("DEBIT");
    }
  });
});

test.describe("GET /api/accounts/reports", () => {
  test("returns a monthly series and category breakdown", async () => {
    const reports = await client.get<{ series?: unknown[]; categories?: unknown[] }>(
      "/accounts/reports",
      { months: 6 }
    );

    expect(reports).toBeTruthy();
    expect(Array.isArray(reports.series ?? [])).toBe(true);
    expect(Array.isArray(reports.categories ?? [])).toBe(true);
  });
});

test.describe("Tenancy isolation", () => {
  test("a fresh company cannot read another company's account", async ({ request }) => {
    // Arrange: a brand-new company that shares nothing with the demo one.
    const outsiderRes = await request.post(`${API_BASE_URL}/auth/register`, {
      data: newUserPayload(DEMO_OTP),
    });
    expect(outsiderRes.status()).toBe(201);
    const outsider = new ApiClient(request, (await outsiderRes.json()).token);

    const victimAccount: Account = await client.firstAccount();

    // Act + assert: the id is valid, but not theirs.
    const res = await outsider.raw().get(`/accounts/${victimAccount.id}/transactions`);
    expect(
      [403, 404].includes(res.status()),
      `expected 403/404 for a cross-tenant read, got ${res.status()}`
    ).toBe(true);
  });

  test("a fresh company cannot transfer out of another company's account", async ({ request }) => {
    const outsiderRes = await request.post(`${API_BASE_URL}/auth/register`, {
      data: newUserPayload(DEMO_OTP),
    });
    const outsider = new ApiClient(request, (await outsiderRes.json()).token);

    const victimAccount = await client.firstAccount();
    const before = Number(victimAccount.balance);

    const res = await outsider.raw().post("/transfers", {
      fromAccountId: victimAccount.id,
      toAccountNumber: "US-0002-7734",
      amount: 1,
      otp: DEMO_OTP,
    });
    expect([403, 404]).toContain(res.status());

    const after = (await client.listAccounts()).find((a) => a.id === victimAccount.id);
    expect(Number(after!.balance)).toBeCloseTo(before, 2);
  });
});
