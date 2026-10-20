import { test as base } from "@playwright/test";
import { LoginPage, OperatorLoginPage } from "../pages/login.page";
import { RegisterPage } from "../pages/register.page";
import { HomePage } from "../pages/home.page";
import { TransferPage } from "../pages/transfer.page";
import { AccountsPage, TransactionsPage } from "../pages/accounts.page";
import { AppShell } from "../pages/shell.page";
import { BudgetsPage, CardsPage, ClaimsPage, VendorBillsPage } from "../pages/spend.page";
import {
  AuditLogPage,
  CreditAppliesPage,
  CustomersPage,
  KybQueuePage,
  OperatorApprovalsPage,
  OperatorHomePage,
} from "../pages/operator.page";

/**
 * WHAT THEY ARE LOOKING AT.
 *
 * One page object per screen, each wrapping the same `page` the test already
 * has — so asking for `transferPage` costs nothing beyond constructing it,
 * and a spec can still drop down to `transferPage.page` for a one-off
 * locator the page object has no method for.
 *
 * Locators live in `pages/`, never inline in a spec: the app has no
 * data-testid attributes, so everything is located the way a screen reader
 * would (getByRole → getByLabel → getByPlaceholder, in that order), and one
 * fix there repairs every spec that touches the screen.
 */
export interface PageFixtures {
  /** /login — the business-customer gate. */
  loginPage: LoginPage;
  /** /dashboard/login — the staff-only gate ("Staff email", not "Email"). */
  operatorLoginPage: OperatorLoginPage;
  /** /register — the two-step company signup wizard. */
  registerPage: RegisterPage;
  /** "/" — the authenticated shell: sidebar, top bar, quick actions. */
  homePage: HomePage;
  /** /transfer — the four-step form → review → OTP → success machine. */
  transferPage: TransferPage;
  /** /accounts/cash — cash accounts and their balances. */
  accountsPage: AccountsPage;
  /** /accounts/transactions — the filterable ledger. */
  transactionsPage: TransactionsPage;

  /** /spend/cards — company cards. */
  cardsPage: CardsPage;
  /** /spend/budgets — spending limits. */
  budgetsPage: BudgetsPage;
  /** /spend/claims — expense claims. */
  claimsPage: ClaimsPage;
  /** /spend/bills — vendor bills. */
  vendorBillsPage: VendorBillsPage;
  /** Search box and notification bell — the frame, not a page. */
  shell: AppShell;

  // --- the back-office console (project "staff", staff storageState) -------

  /** /dashboard — the operator landing page. */
  operatorHomePage: OperatorHomePage;
  /** /dashboard/customers — every company on the platform. */
  customersPage: CustomersPage;
  /** /dashboard/kyb — the business-verification queue. */
  kybQueuePage: KybQueuePage;
  /** /dashboard/credit-applies — Credit Apply, maker and checker. */
  creditAppliesPage: CreditAppliesPage;
  /** /dashboard/approvals — the three request queues. */
  operatorApprovalsPage: OperatorApprovalsPage;
  /** /dashboard/audit-log — the platform-wide audit trail. */
  auditLogPage: AuditLogPage;
}

export const pagesTest = base.extend<PageFixtures>({
  loginPage: async ({ page }, use) => use(new LoginPage(page)),
  operatorLoginPage: async ({ page }, use) => use(new OperatorLoginPage(page)),
  registerPage: async ({ page }, use) => use(new RegisterPage(page)),
  homePage: async ({ page }, use) => use(new HomePage(page)),
  transferPage: async ({ page }, use) => use(new TransferPage(page)),
  accountsPage: async ({ page }, use) => use(new AccountsPage(page)),
  transactionsPage: async ({ page }, use) => use(new TransactionsPage(page)),

  cardsPage: async ({ page }, use) => use(new CardsPage(page)),
  budgetsPage: async ({ page }, use) => use(new BudgetsPage(page)),
  claimsPage: async ({ page }, use) => use(new ClaimsPage(page)),
  vendorBillsPage: async ({ page }, use) => use(new VendorBillsPage(page)),
  shell: async ({ page }, use) => use(new AppShell(page)),

  operatorHomePage: async ({ page }, use) => use(new OperatorHomePage(page)),
  customersPage: async ({ page }, use) => use(new CustomersPage(page)),
  kybQueuePage: async ({ page }, use) => use(new KybQueuePage(page)),
  creditAppliesPage: async ({ page }, use) => use(new CreditAppliesPage(page)),
  operatorApprovalsPage: async ({ page }, use) => use(new OperatorApprovalsPage(page)),
  auditLogPage: async ({ page }, use) => use(new AuditLogPage(page)),
});
