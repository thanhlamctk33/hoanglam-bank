import { Locator, Page, expect } from "@playwright/test";
import { BasePage } from "./base.page";

/** /accounts/cash — the list of company cash accounts and their balances. */
export class AccountsPage extends BasePage {
  readonly path = "/accounts/cash";

  readonly recentActivity: Locator;

  constructor(page: Page) {
    super(page);
    this.recentActivity = page.getByRole("heading", { name: /recent activity/i });
  }

  async waitUntilReady() {
    await expect(this.heading(/cash accounts/i)).toBeVisible({ timeout: 30_000 });
  }

  /** The card/row for a given account number, e.g. "US-0001-…". */
  accountCard(accountNumber: string): Locator {
    return this.page.getByText(accountNumber).first();
  }

  /** Every formatted money value rendered on the page. */
  balances(): Locator {
    return this.page.getByText(/[$€£]\s?[\d,]+\.\d{2}/);
  }
}

/** /accounts/transactions — the filterable ledger. */
export class TransactionsPage extends BasePage {
  readonly path = "/accounts/transactions";

  async waitUntilReady() {
    await expect(this.heading(/^transactions$/i)).toBeVisible({ timeout: 30_000 });
  }

  /** Rows whose text contains the given note/description. */
  rowsContaining(text: string | RegExp): Locator {
    return this.page.getByText(text);
  }
}
