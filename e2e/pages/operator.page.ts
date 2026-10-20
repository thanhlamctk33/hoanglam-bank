import { Locator, Page, expect } from "@playwright/test";
import { BasePage } from "./base.page";

/**
 * The back-office Operator Console at /dashboard.
 *
 * It is a different application shell from the customer app — its own
 * sidebar, its own top bar, its own login gate — and it runs under a staff
 * session, never a customer one. That is why these page objects live apart
 * from the customer ones and why the specs that use them sit in their own
 * Playwright project (`staff`), loading .auth/staff.json.
 */
export abstract class OperatorPage extends BasePage {
  /** The console's left-hand navigation. */
  get sidebar(): Locator {
    return this.page.locator("aside").first();
  }

  /** Clicks a top-level console link by its sidebar label. */
  async navigateTo(label: string | RegExp) {
    await this.page.getByRole("link", { name: label }).first().click();
  }
}

/** /dashboard — the operator landing page. */
export class OperatorHomePage extends OperatorPage {
  readonly path = "/dashboard";

  readonly recentActivity: Locator;

  constructor(page: Page) {
    super(page);
    // The greeting heading interpolates the operator's first name, so it is
    // not a stable locator; this section title is.
    this.recentActivity = page.getByRole("heading", { name: /recent activity/i });
  }

  async waitUntilReady() {
    await expect(this.recentActivity).toBeVisible({ timeout: 30_000 });
  }
}

/** /dashboard/customers — every company on the platform. */
export class CustomersPage extends OperatorPage {
  readonly path = "/dashboard/customers";

  async waitUntilReady() {
    await expect(this.heading(/^customers$/i)).toBeVisible({ timeout: 30_000 });
  }

  /** The row for a company, located by its name. */
  row(companyName: string): Locator {
    return this.page.getByText(companyName).first();
  }
}

/** /dashboard/kyb — the business-verification queue. */
export class KybQueuePage extends OperatorPage {
  readonly path = "/dashboard/kyb";

  async waitUntilReady() {
    await expect(this.heading(/^business verification$/i)).toBeVisible({ timeout: 30_000 });
  }
}

/** /dashboard/credit-applies — Credit Apply, maker and checker. */
export class CreditAppliesPage extends OperatorPage {
  readonly path = "/dashboard/credit-applies";

  async waitUntilReady() {
    await expect(this.heading(/^credit applications$/i)).toBeVisible({ timeout: 30_000 });
  }
}

/** /dashboard/approvals — the three request queues. */
export class OperatorApprovalsPage extends OperatorPage {
  readonly path = "/dashboard/approvals";

  readonly cardQueue: Locator;
  readonly budgetQueue: Locator;
  readonly claimQueue: Locator;

  constructor(page: Page) {
    super(page);
    this.cardQueue = page.getByRole("link", { name: /card requests/i });
    this.budgetQueue = page.getByRole("link", { name: /budget requests/i });
    this.claimQueue = page.getByRole("link", { name: /expense claims/i });
  }

  async waitUntilReady() {
    await expect(this.heading(/^approvals$/i)).toBeVisible({ timeout: 30_000 });
  }
}

/** /dashboard/audit-log — the platform-wide audit trail. */
export class AuditLogPage extends OperatorPage {
  readonly path = "/dashboard/audit-log";

  async waitUntilReady() {
    await expect(this.heading(/^audit log$/i)).toBeVisible({ timeout: 30_000 });
  }
}
