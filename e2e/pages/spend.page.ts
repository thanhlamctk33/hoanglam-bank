import { Locator, Page, expect } from "@playwright/test";
import { BasePage } from "./base.page";

/**
 * The Spend section: cards, budgets, claims and vendor bills.
 *
 * Each of these screens renders the same shape — a heading, a row of stat
 * tiles, a primary action whose LABEL depends on whether the signed-in user
 * can approve (an Admin issues; a Member requests) — so the page objects
 * expose that difference rather than hiding it: `primaryAction` matches
 * either wording, and a spec that cares which one it got can say so.
 */

/** /spend/cards — company cards. */
export class CardsPage extends BasePage {
  readonly path = "/spend/cards";

  /** "Issue new card" for an Admin, "Request new card" for a Member. */
  readonly primaryAction: Locator;
  readonly activeCardsTile: Locator;

  constructor(page: Page) {
    super(page);
    this.primaryAction = page.getByRole("button", { name: /(issue|request) new card/i });
    this.activeCardsTile = page.getByText(/^active cards$/i);
  }

  async waitUntilReady() {
    await expect(this.heading(/^company cards$/i)).toBeVisible({ timeout: 30_000 });
  }

  /** The tile/row for a card, located by the label it was issued with. */
  card(label: string): Locator {
    return this.page.getByText(label).first();
  }
}

/** /spend/budgets — spending limits. */
export class BudgetsPage extends BasePage {
  readonly path = "/spend/budgets";

  /** "New budget" for an Admin, "Request budget" for a Member. */
  readonly primaryAction: Locator;
  readonly totalBudgetedTile: Locator;

  constructor(page: Page) {
    super(page);
    this.primaryAction = page.getByRole("button", { name: /(new|request) budget/i });
    this.totalBudgetedTile = page.getByText(/^total budgeted$/i);
  }

  async waitUntilReady() {
    await expect(this.heading(/^spending limits$/i)).toBeVisible({ timeout: 30_000 });
  }

  budget(name: string): Locator {
    return this.page.getByText(name).first();
  }
}

/** /spend/claims — expense claims, with the receipt library as a second tab. */
export class ClaimsPage extends BasePage {
  readonly path = "/spend/claims";

  async waitUntilReady() {
    await expect(this.heading(/^expense claims$/i)).toBeVisible({ timeout: 30_000 });
  }

  claim(title: string): Locator {
    return this.page.getByText(title).first();
  }
}

/** /spend/bills — vendor bills (distinct from Payments → Bill payment). */
export class VendorBillsPage extends BasePage {
  readonly path = "/spend/bills";

  async waitUntilReady() {
    await expect(this.heading(/^vendor bills$/i)).toBeVisible({ timeout: 30_000 });
  }

  bill(vendor: string): Locator {
    return this.page.getByText(vendor).first();
  }
}
