import { test, expect } from "../../fixtures/test";
import { SECOND_USER } from "../../utils/env";
import { smallAmount, uniqueSuffix } from "../../utils/data";

/**
 * The money-movement happy path and its guard rails.
 *
 * These specs run signed in via the shared storageState, and use the `api`
 * fixture to read balances directly instead of scraping formatted currency
 * out of the DOM — the assertion is then about the ledger, not the formatter.
 */

test.describe("One-off internal transfer", () => {
  test("moves money and debits the source account", async ({ transferPage, api }) => {
    const source = await api.firstAccount("USD");
    const amount = smallAmount();
    const note = `e2e ${uniqueSuffix()}`;

    await transferPage.goto();
    await transferPage.completeInternalTransfer({
      toAccountNumber: SECOND_USER.accountNumber,
      amount,
      note,
    });

    const after = (await api.listAccounts()).find((a) => a.id === source.id);
    expect(after, "source account still exists after the transfer").toBeTruthy();
    expect(Number(after!.balance)).toBeCloseTo(Number(source.balance) - amount, 2);
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

  test("a wrong OTP is rejected and no money moves", async ({ transferPage, api }) => {
    const source = await api.firstAccount("USD");

    await transferPage.goto();
    await transferPage.fillInternalForm({
      toAccountNumber: SECOND_USER.accountNumber,
      amount: smallAmount(),
    });
    await transferPage.submitForReview();
    await transferPage.confirmReview();
    await transferPage.enterOtp("1234");

    await expect(transferPage.otpError()).toContainText(/invalid otp/i);
    await expect(transferPage.successHeading).toBeHidden();

    const after = (await api.listAccounts()).find((a) => a.id === source.id);
    expect(Number(after!.balance)).toBeCloseTo(Number(source.balance), 2);
  });

  test("warns when the amount exceeds the available balance", async ({ transferPage, api }) => {
    const source = await api.firstAccount("USD");

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
