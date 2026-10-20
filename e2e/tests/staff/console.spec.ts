import { test, expect, LOGGED_OUT_STATE } from "../../fixtures/test";

/**
 * The Operator Console shell, under a STAFF session.
 *
 * This project loads .auth/staff.json rather than the customer state, so the
 * assertions here are as much about the session boundary as about the pages:
 * a customer must never be able to render these screens, and a staff user
 * must reach every one of them from the console's own sidebar.
 */

// Every top-level console area, paired with the <h1> that page owns. The
// pairing is the point: a screen that silently swaps to an error boundary
// still renders *something*, but not its own heading.
const CONSOLE_ROUTES: { path: string; heading: RegExp; sidebarLabel: RegExp }[] = [
  { path: "/dashboard/customers", heading: /^customers$/i, sidebarLabel: /^customers$/i },
  { path: "/dashboard/approvals", heading: /^approvals$/i, sidebarLabel: /^approvals$/i },
  {
    path: "/dashboard/kyb",
    heading: /^business verification$/i,
    sidebarLabel: /^business verification$/i,
  },
  {
    path: "/dashboard/credit-applies",
    heading: /^credit applications$/i,
    sidebarLabel: /^credit applications$/i,
  },
  { path: "/dashboard/audit-log", heading: /^audit log$/i, sidebarLabel: /^audit log$/i },
];

test.describe("Console shell", () => {
  for (const route of CONSOLE_ROUTES) {
    test(`renders ${route.path} without an error boundary`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));

      await page.goto(route.path);

      await expect(page.getByRole("heading", { name: route.heading })).toBeVisible({
        timeout: 30_000,
      });
      expect(pageErrors, `${route.path} threw during render`).toEqual([]);
    });
  }

  test("the operator landing page shows recent platform activity", async ({
    operatorHomePage,
  }) => {
    await operatorHomePage.goto();
    await expect(operatorHomePage.recentActivity).toBeVisible();
  });

  test("the sidebar reaches every console area", async ({ operatorHomePage, page }) => {
    await operatorHomePage.goto();

    for (const route of CONSOLE_ROUTES) {
      await operatorHomePage.navigateTo(route.sidebarLabel);
      await expect(page).toHaveURL(new RegExp(`${route.path}$`));
      await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
    }
  });
});

test.describe("The console gate", () => {
  test.use({ storageState: LOGGED_OUT_STATE });

  test("an anonymous visitor is sent to the staff login", async ({ page }) => {
    await page.goto("/dashboard/customers");

    await expect(page).toHaveURL(/\/dashboard\/login/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: /operator console/i })).toBeVisible();
  });

  test("the staff gate refuses a company customer", async ({ operatorLoginPage, page }) => {
    await operatorLoginPage.goto();
    // A perfectly valid customer login — wrong door. The gate must not hand
    // a company user a cross-company console session.
    await operatorLoginPage.login("demo@lambank.dev", "password123");

    await expect(page).toHaveURL(/\/dashboard\/login/);
    await expect(page.getByRole("heading", { name: /operator console/i })).toBeVisible();
  });
});
