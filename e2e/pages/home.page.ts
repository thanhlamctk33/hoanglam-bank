import { Locator, Page, expect } from "@playwright/test";
import { BasePage } from "./base.page";

/**
 * The authenticated landing page at "/" — balances, quick actions, recent
 * activity — plus the app shell (sidebar/topbar) that wraps every inner page.
 */
export class HomePage extends BasePage {
  readonly path = "/";

  readonly sidebar: Locator;
  readonly quickActions: Locator;
  readonly transferQuickAction: Locator;

  constructor(page: Page) {
    super(page);
    this.sidebar = page.locator("aside").first();
    this.quickActions = page.getByRole("link", { name: /transfer money|pay a bill|add a card|invite teammate/i });
    this.transferQuickAction = page.getByRole("link", { name: /transfer money/i }).first();
  }

  async waitUntilReady() {
    // The quick-action row renders as soon as the shell is past RequireAuth,
    // which is the cheapest reliable "we're signed in and on the app" signal.
    await expect(this.transferQuickAction).toBeVisible({ timeout: 30_000 });
  }

  /** Expands a sidebar section (Accounts, Payments, …) and clicks a child link. */
  async navigateVia(section: RegExp | string, child: RegExp | string) {
    const sectionButton = this.page.getByRole("button", { name: section });
    if (await sectionButton.isVisible()) {
      // Sections auto-expand when the current route matches, so only toggle
      // the ones that are still collapsed.
      const link = this.page.getByRole("link", { name: child });
      if (!(await link.isVisible().catch(() => false))) {
        await sectionButton.click();
      }
    }
    await this.page.getByRole("link", { name: child }).first().click();
  }

  /** Any element rendering a formatted currency amount, e.g. "$12,345.67". */
  moneyAmounts(): Locator {
    return this.page.getByText(/[$€£]\s?[\d,]+\.\d{2}/);
  }
}
