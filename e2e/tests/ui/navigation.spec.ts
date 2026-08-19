import { test, expect, clearSession } from "../../fixtures/test";

/**
 * Smoke coverage for the app shell: the sidebar reaches every major area, the
 * pages render their own heading rather than an error boundary, and a dropped
 * session is caught by RequireAuth.
 */

// Each entry pairs a route with the <h1> that page owns, so the assertion
// fails loudly if a screen silently swaps to the error boundary.
const ROUTES: { path: string; heading: RegExp }[] = [
  { path: "/accounts/cash", heading: /^cash accounts$/i },
  { path: "/accounts/transactions", heading: /^transactions$/i },
  { path: "/accounts/reports", heading: /^reports$/i },
  { path: "/transfer", heading: /^one-off transfer$/i },
  { path: "/transfer/recurring", heading: /^recurring transfers$/i },
  { path: "/payments/bills", heading: /^bill payment$/i },
  { path: "/spend/cards", heading: /^company cards$/i },
  { path: "/spend/budgets", heading: /^spending limits$/i },
  { path: "/spend/claims", heading: /^expense claims$/i },
  { path: "/credit", heading: /^credit$/i },
  { path: "/settings/team", heading: /^team$/i },
];

test.describe("App shell", () => {
  for (const route of ROUTES) {
    test(`renders ${route.path} without an error boundary`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("pageerror", (err) => consoleErrors.push(err.message));

      await page.goto(route.path);

      await expect(page.getByRole("heading", { name: route.heading }).first()).toBeVisible({
        timeout: 30_000,
      });
      // error.tsx renders this copy; seeing it means the page threw.
      await expect(page.getByText(/something went wrong/i)).toBeHidden();
      expect(consoleErrors, `uncaught page errors on ${route.path}`).toEqual([]);
    });
  }

  test("the sidebar navigates to the transfer screen", async ({ homePage, page }) => {
    await homePage.goto();
    await homePage.navigateVia(/payments/i, /one-off transfer/i);

    await expect(page).toHaveURL(/\/transfer$/);
    await expect(page.getByRole("heading", { name: /one-off transfer/i })).toBeVisible();
  });

  test("quick actions on the home page link out to their feature", async ({ homePage, page }) => {
    await homePage.goto();
    await homePage.transferQuickAction.click();

    await expect(page).toHaveURL(/\/transfer/);
  });

  test("a dropped token sends the user back to /login", async ({ homePage, page }) => {
    await homePage.goto();
    await clearSession(page);
    await page.reload();

    await page.waitForURL(/\/login/, { timeout: 20_000 });
  });
});
