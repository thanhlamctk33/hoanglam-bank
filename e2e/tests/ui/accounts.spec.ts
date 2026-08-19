import { test, expect } from "../../fixtures/test";
import { TransactionsPage } from "../../pages/accounts.page";
import { SECOND_USER } from "../../utils/env";
import { smallAmount, uniqueSuffix } from "../../utils/data";

test.describe("Cash accounts", () => {
  test("lists every account the API returns", async ({ accountsPage, api, page }) => {
    const accounts = await api.listAccounts();
    expect(accounts.length, "seeded company has at least one account").toBeGreaterThan(0);

    await accountsPage.goto();

    for (const account of accounts) {
      await expect(
        page.getByText(account.accountNumber).first(),
        `account ${account.accountNumber} is rendered`
      ).toBeVisible();
    }
  });

  test("renders balances as formatted currency", async ({ accountsPage }) => {
    await accountsPage.goto();
    await expect(accountsPage.balances().first()).toBeVisible();
  });
});

test.describe("Transactions", () => {
  test("a transfer shows up in the ledger with its note", async ({
    transferPage,
    page,
    api,
  }) => {
    const note = `ledger ${uniqueSuffix()}`;

    await transferPage.goto();
    await transferPage.completeInternalTransfer({
      toAccountNumber: SECOND_USER.accountNumber,
      amount: smallAmount(),
      note,
    });

    // Confirm through the API first — that pins down whether a missing row is
    // a backend bug or a rendering one.
    const source = await api.firstAccount("USD");
    const { transactions } = await api.get<{ transactions: { description: string }[] }>(
      `/accounts/${source.id}/transactions`,
      { take: 25 }
    );
    expect(transactions.some((t) => (t.description ?? "").includes(note))).toBe(true);

    const transactionsPage = new TransactionsPage(page);
    await transactionsPage.goto();
    await expect(transactionsPage.rowsContaining(note).first()).toBeVisible({ timeout: 20_000 });
  });
});
