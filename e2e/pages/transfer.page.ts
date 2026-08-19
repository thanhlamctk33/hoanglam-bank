import { Locator, Page, expect } from "@playwright/test";
import { BasePage } from "./base.page";
import { DEMO_OTP } from "../utils/env";

/**
 * The one-off transfer wizard at /transfer.
 *
 * The screen is a four-step state machine — form → review → OTP → success —
 * rendered by swapping panels, not by navigating. Each step below waits for
 * its own panel heading so a slow API call can't make the next step click a
 * button that hasn't mounted yet.
 */
export class TransferPage extends BasePage {
  readonly path = "/transfer";

  // step 1 — form
  readonly fromAccountSelect: Locator;
  readonly recipientAccountInput: Locator;
  readonly amountInput: Locator;
  readonly noteInput: Locator;
  readonly reviewButton: Locator;

  // step 2 — review
  readonly reviewHeading: Locator;
  readonly continueButton: Locator;
  readonly backButton: Locator;

  // step 3 — OTP
  readonly otpHeading: Locator;
  readonly otpInput: Locator;
  readonly confirmButton: Locator;

  // step 4 — success
  readonly successHeading: Locator;
  readonly anotherTransferButton: Locator;

  constructor(page: Page) {
    super(page);

    this.fromAccountSelect = page.getByLabel(/from account/i);
    this.recipientAccountInput = page.getByLabel(/recipient account number/i);
    this.amountInput = page.getByPlaceholder("0.00");
    this.noteInput = page.getByPlaceholder(/what's this for/i);
    this.reviewButton = page.getByRole("button", { name: /review transfer/i });

    this.reviewHeading = page.getByRole("heading", { name: /review transfer/i });
    this.continueButton = page.getByRole("button", { name: /^continue$/i });
    this.backButton = page.getByRole("button", { name: /^back$/i });

    this.otpHeading = page.getByRole("heading", { name: /enter otp/i });
    this.otpInput = page.getByPlaceholder("••••");
    this.confirmButton = page.getByRole("button", { name: /confirm & transfer/i });

    this.successHeading = page.getByText(/transfer complete/i);
    this.anotherTransferButton = page.getByRole("button", { name: /make another transfer/i });
  }

  async waitUntilReady() {
    await expect(this.heading(/one-off transfer/i)).toBeVisible({ timeout: 30_000 });
    // The account picker is populated by GET /accounts; without this the
    // first fill() can land before any <option> exists.
    await expect(this.fromAccountSelect.locator("option").first()).toBeAttached();
  }

  /** Switches the send-mode tab: internal / FX / wire / receive-by-QR. */
  async selectMode(mode: "internal" | "fx" | "wire" | "receive") {
    const labels = {
      internal: /internal transfer/i,
      fx: /fx transfer/i,
      wire: /wire transfer/i,
      receive: /receive via qr/i,
    } as const;
    await this.button(labels[mode]).click();
  }

  async fillInternalForm(input: { toAccountNumber: string; amount: number; note?: string }) {
    await this.recipientAccountInput.fill(input.toAccountNumber);
    await this.amountInput.fill(String(input.amount));
    if (input.note) await this.noteInput.fill(input.note);
  }

  async submitForReview() {
    await expect(this.reviewButton).toBeEnabled();
    await this.reviewButton.click();
    await expect(this.reviewHeading).toBeVisible();
  }

  async confirmReview() {
    await this.continueButton.click();
    await expect(this.otpHeading).toBeVisible();
  }

  async enterOtp(code = DEMO_OTP) {
    await this.otpInput.fill(code);
    // The confirm button stays disabled until the code is the full length.
    await expect(this.confirmButton).toBeEnabled();
    await this.confirmButton.click();
  }

  /** Runs the whole happy path in one call. */
  async completeInternalTransfer(input: {
    toAccountNumber: string;
    amount: number;
    note?: string;
    otp?: string;
  }) {
    await this.fillInternalForm(input);
    await this.submitForReview();
    await this.confirmReview();
    await this.enterOtp(input.otp ?? DEMO_OTP);
    await expect(this.successHeading).toBeVisible({ timeout: 20_000 });
  }

  /** Red inline error shown on the OTP panel when the code is rejected. */
  otpError(): Locator {
    return this.page.locator("div.bg-red-50").first();
  }

  /** The "Amount exceeds available balance." hint under the amount field. */
  insufficientBalanceWarning(): Locator {
    return this.page.getByText(/amount exceeds available balance/i);
  }
}
