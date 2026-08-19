import { Locator, Page, expect } from "@playwright/test";

/**
 * Shared behaviour for every page object.
 *
 * The app has no data-testid attributes, so all locators here are built from
 * roles, labels and visible text — the same things a user sees. That makes the
 * selectors survive class/markup churn, and it means a broken locator usually
 * signals a real accessibility problem rather than a flaky test.
 */
export abstract class BasePage {
  // Public so a spec can drop down to a raw locator for the odd one-off
  // assertion without the page object having to grow a method for it.
  constructor(readonly page: Page) {}

  /** Path this page lives at, e.g. "/transfer". */
  abstract readonly path: string;

  async goto(): Promise<void> {
    await this.page.goto(this.path);
    await this.waitUntilReady();
  }

  /** Overridden per page to block on the element that proves it finished loading. */
  async waitUntilReady(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded");
  }

  heading(name: string | RegExp): Locator {
    return this.page.getByRole("heading", { name });
  }

  button(name: string | RegExp): Locator {
    return this.page.getByRole("button", { name });
  }

  /**
   * Waits for a specific backend call to finish. Far more reliable than a
   * fixed timeout when a click kicks off a fetch that then repaints the page.
   */
  async waitForApi(pathFragment: string, method = "GET") {
    return this.page.waitForResponse(
      (res) =>
        res.url().includes(pathFragment) &&
        res.request().method() === method &&
        res.status() < 400
    );
  }

  async expectVisible(locator: Locator) {
    await expect(locator).toBeVisible();
  }
}
