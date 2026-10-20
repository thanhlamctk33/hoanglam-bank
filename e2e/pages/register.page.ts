import { Locator, Page, expect } from "@playwright/test";
import { BasePage } from "./base.page";
import { DEMO_OTP } from "../utils/env";

/**
 * /register — a two-step wizard: the company/contact form, then a phone OTP.
 * Both steps render into the same card, so the OTP locators only resolve once
 * "Continue" has been pressed.
 */
export class RegisterPage extends BasePage {
  readonly path = "/register";

  readonly companyNameInput: Locator;
  readonly nameInput: Locator;
  readonly emailInput: Locator;
  readonly phoneInput: Locator;
  readonly passwordInput: Locator;
  readonly continueButton: Locator;

  readonly otpInput: Locator;
  readonly verifyButton: Locator;
  readonly backButton: Locator;

  constructor(page: Page) {
    super(page);

    this.companyNameInput = page.getByLabel(/company name/i);
    this.nameInput = page.getByLabel(/your name/i);
    this.emailInput = page.getByLabel(/email/i);
    this.phoneInput = page.getByLabel(/phone number/i);
    // PasswordInput puts a "Show password" button inside the <label>, so a
    // plain getByLabel("Password") matches both the field and that button.
    this.passwordInput = page.getByRole("textbox", { name: /^password/i });
    this.continueButton = page.getByRole("button", { name: /^continue$/i });

    this.otpInput = page.getByPlaceholder("••••");
    this.verifyButton = page.getByRole("button", { name: /verify & create account/i });
    this.backButton = page.getByRole("button", { name: /^back$/i });
  }

  async waitUntilReady() {
    await expect(this.heading(/create your business account/i)).toBeVisible();
  }

  async fillForm(input: {
    companyName: string;
    name: string;
    email: string;
    phone: string;
    password: string;
  }) {
    await this.companyNameInput.fill(input.companyName);
    await this.nameInput.fill(input.name);
    await this.emailInput.fill(input.email);
    await this.phoneInput.fill(input.phone);
    await this.passwordInput.fill(input.password);
  }

  async continueToOtp() {
    await this.continueButton.click();
    await expect(this.heading(/verify your phone/i)).toBeVisible();
  }

  async submitOtp(code = DEMO_OTP) {
    await this.otpInput.fill(code);
    await expect(this.verifyButton).toBeEnabled();
    await this.verifyButton.click();
  }

  /** Red inline error, shown on whichever step is currently mounted. */
  error(): Locator {
    return this.page.locator("form div.text-red-600").first();
  }
}
