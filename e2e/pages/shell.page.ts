import { Locator, Page, expect } from "@playwright/test";

/**
 * The parts of the app shell that sit on EVERY authenticated screen: the
 * global search box and the notification bell.
 *
 * Not a BasePage — it has no path of its own. A spec navigates wherever it
 * likes and then reaches for this, which is the honest model: these controls
 * belong to the frame, not to a page.
 */
export class AppShell {
  readonly searchInput: Locator;
  readonly notificationBell: Locator;
  readonly notificationsPanel: Locator;

  constructor(readonly page: Page) {
    // The placeholder greets the user by name ("Hi Demo, search for anything
    // here"), so only the stable tail is matched.
    this.searchInput = page.getByPlaceholder(/search for anything here/i);
    this.notificationBell = page.getByRole("button", { name: /^notifications$/i });
    this.notificationsPanel = page.getByRole("heading", { name: /^notifications$/i });
  }

  async openNotifications() {
    await this.notificationBell.click();
    await expect(this.notificationsPanel).toBeVisible();
  }

  /** Types into global search and waits for the cross-app dropdown. */
  async search(term: string) {
    await this.searchInput.fill(term);
  }

  /** A result group in the search dropdown, e.g. "Expense Claims". */
  resultGroup(name: string | RegExp): Locator {
    return this.page.getByText(name);
  }
}
