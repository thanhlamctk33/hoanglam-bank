import { Locator, Page, expect } from "@playwright/test";
import { BasePage } from "./base.page";

/** The business-customer login gate at /login. */
export class LoginPage extends BasePage {
  readonly path = "/login";

  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly rememberEmailCheckbox: Locator;
  readonly submitButton: Locator;
  readonly createAccountLink: Locator;

  constructor(page: Page) {
    super(page);
    this.emailInput = page.getByLabel("Email");
    this.passwordInput = page.getByLabel("Password", { exact: false });
    this.rememberEmailCheckbox = page.getByLabel(/remember my email/i);
    this.submitButton = page.getByRole("button", { name: /^log in$/i });
    this.createAccountLink = page.getByRole("link", { name: /create one/i });
  }

  async waitUntilReady() {
    await expect(this.heading(/log in to your account/i)).toBeVisible();
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  /** The inline red error rendered above the form on a failed attempt. */
  error(): Locator {
    return this.page.locator("form div.text-red-400").first();
  }
}

/** The staff-only gate at /dashboard/login. */
export class OperatorLoginPage extends BasePage {
  readonly path = "/dashboard/login";

  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    super(page);
    this.emailInput = page.getByLabel(/staff email/i);
    this.passwordInput = page.getByLabel("Password", { exact: false });
    this.submitButton = page.getByRole("button", { name: /log in/i });
  }

  async waitUntilReady() {
    await expect(this.heading(/operator console/i)).toBeVisible();
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
