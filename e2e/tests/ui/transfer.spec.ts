import { test, expect } from "../../fixtures/test";
import { ApiClient } from "../../utils/api-client";
import { SECOND_USER } from "../../utils/env";
import { smallAmount, uniqueSuffix } from "../../utils/data";

/**
 * The money-movement happy path and its guard rails.
 *
 * These specs run signed in via the shared storageState, so unlike the API
 * specs they cannot move to an isolated sandbox company — the browser session
 * belongs to the seeded demo user, and every UI spec shares it.
 *
 * They therefore assert against the *ledger* rather than against absolute
 * balance arithmetic: "a DEBIT of exactly this amount carrying this unique
 * note exists" is both stronger (it pins the amount to a specific, attributable
 * row) and immune to another spec spending from the same account on another
 * worker at the same moment. `before - amount` would be a race.
 */

interface LedgerRow {
  amount: number | string;
  type: "DEBIT" | "CREDIT";
  description: string;
}

/** The demo account's most recent rows, read over HTTP rather than scraped. */
async function recentRows(api: ApiClient, accountId: string): Promise<LedgerRow[]> {
  const { transactions } = await api.get<{ transactions: LedgerRow[] }>(
    `/accounts/${accountId}/transactions`,
    { take: 25 }
  );
  return transactions;
}

test.describe("One-off internal transfer", () => {
  test("moves money and debits the source account", async ({ transferPage, adminApi }) => {
    const source = await adminApi.firstAccount("USD");
    const amount = smallAmount();
    const note = `e2e ${uniqueSuffix()}`;

    await transferPage.goto();
    await transferPage.completeInternalTransfer({
      toAccountNumber: SECOND_USER.accountNumber,
      amount,
      note,
    });

    const debit = (await recentRows(adminApi, source.id)).find(
      (row) => row.type === "DEBIT" && (row.description ?? "").includes(note)
    );
    expect(debit, "the UI transfer produced a debit row carrying its note").toBeTruthy();
    expect(Number(debit!.amount)).toBeCloseTo(amount, 2);
  });

  test("shows the entered details on the review step before committing", async ({
    transferPage,
  }) => {
    const amount = smallAmount();
    const note = `review ${uniqueSuffix()}`;

    await transferPage.goto();
    await transferPage.fillInternalForm({
      toAccountNumber: SECOND_USER.accountNumber,
      amount,
      note,
    });
    await transferPage.submitForReview();

    await expect(transferPage.reviewHeading).toBeVisible();
    await expect(
      transferPage.page.getByText(SECOND_USER.accountNumber).first()
    ).toBeVisible();
    await expect(transferPage.page.getByText(note).first()).toBeVisible();
  });

  test("a wrong OTP is rejected and no money moves", async ({ transferPage, adminApi }) => {
    const source = await adminApi.firstAccount("USD");
    // The note is what makes "nothing moved" checkable: if the rejected
    // attempt had leaked a debit through, it would be the row carrying this.
    const note = `rejected ${uniqueSuffix()}`;

    await transferPage.goto();
    await transferPage.fillInternalForm({
      toAccountNumber: SECOND_USER.accountNumber,
      amount: smallAmount(),
      note,
    });
    await transferPage.submitForReview();
    await transferPage.confirmReview();
    await transferPage.enterOtp("1234");

    await expect(transferPage.otpError()).toContainText(/invalid otp/i);
    await expect(transferPage.successHeading).toBeHidden();

    const leaked = (await recentRows(adminApi, source.id)).filter((row) =>
      (row.description ?? "").includes(note)
    );
    expect(leaked, "a rejected OTP must not write anything to the ledger").toEqual([]);
  });

  test("warns when the amount exceeds the available balance", async ({ transferPage, adminApi }) => {
    const source = await adminApi.firstAccount("USD");

    await transferPage.goto();
    await transferPage.fillInternalForm({
      toAccountNumber: SECOND_USER.accountNumber,
      amount: Number(source.balance) + 1_000_000,
    });

    await expect(transferPage.insufficientBalanceWarning()).toBeVisible();
    await expect(transferPage.reviewButton).toBeDisabled();
  });

  test("the back button returns from review to an intact form", async ({ transferPage }) => {
    const amount = smallAmount();

    await transferPage.goto();
    await transferPage.fillInternalForm({
      toAccountNumber: SECOND_USER.accountNumber,
      amount,
    });
    await transferPage.submitForReview();
    await transferPage.backButton.click();

    await expect(transferPage.recipientAccountInput).toHaveValue(SECOND_USER.accountNumber);
    await expect(transferPage.amountInput).toHaveValue(String(amount));
  });
});

test.describe("Transfer modes", () => {
  test("switching to FX swaps in the recipient/currency fields", async ({ transferPage, page }) => {
    await transferPage.goto();
    await transferPage.selectMode("fx");

    await expect(page.getByLabel(/recipient name/i)).toBeVisible();
    await expect(transferPage.recipientAccountInput).toBeHidden();
  });

  test("switching to wire asks for a routing number", async ({ transferPage, page }) => {
    await transferPage.goto();
    await transferPage.selectMode("wire");

    await expect(page.getByLabel(/routing number \/ swift code/i)).toBeVisible();
    await expect(page.getByLabel(/bank name/i)).toBeVisible();
  });

  test("receive-via-QR renders a pay code", async ({ transferPage, page }) => {
    await transferPage.goto();
    await transferPage.selectMode("receive");

    await expect(page.getByRole("heading", { name: /receive via qr/i })).toBeVisible();
    await expect(page.locator("canvas, img[src^='data:image']").first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
