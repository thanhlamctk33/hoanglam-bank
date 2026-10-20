import { test, expect } from "../../fixtures/test";

/**
 * /dashboard/customers — cross-company oversight.
 *
 * Arranged over HTTP and asserted through the UI: `staffApi` says which
 * companies the platform has, and the page has to show them. That is
 * stronger than asserting "some rows rendered", and it is what would catch
 * the console quietly scoping itself to the staff user's own company — the
 * exact bug that would make this screen useless.
 */

interface Customer {
  id: string;
  name: string;
}

test.describe("Customers", () => {
  test("lists the companies the admin API returns", async ({ customersPage, staffApi, page }) => {
    const { customers } = await staffApi.get<{ customers: Customer[] }>("/admin/customers");
    expect(customers.length, "the platform has at least one company to show").toBeGreaterThan(0);

    await customersPage.goto();

    // Check the first few rather than all of them: the page paginates, and
    // the assertion is "the console shows the platform's companies", not
    // "the console renders every company at once".
    for (const customer of customers.slice(0, 3)) {
      await expect(page.getByText(customer.name).first()).toBeVisible();
    }
  });

  test("the seeded demo company is reachable from the console", async ({
    customersPage,
    staffApi,
  }) => {
    const { customers } = await staffApi.get<{ customers: Customer[] }>("/admin/customers");
    const demo = customers.find((c) => /demo trading/i.test(c.name));
    test.skip(!demo, "seeded demo company not present — run npm run seed in backend/");

    await customersPage.goto();
    await expect(customersPage.row(demo!.name)).toBeVisible();
  });
});

test.describe("Approval queues", () => {
  test("the overview offers a queue for cards, budgets and claims", async ({
    operatorApprovalsPage,
  }) => {
    await operatorApprovalsPage.goto();

    await expect(operatorApprovalsPage.cardQueue).toBeVisible();
    await expect(operatorApprovalsPage.budgetQueue).toBeVisible();
    await expect(operatorApprovalsPage.claimQueue).toBeVisible();
  });

  test("a queue card opens its own page", async ({ operatorApprovalsPage, page }) => {
    await operatorApprovalsPage.goto();
    await operatorApprovalsPage.cardQueue.click();

    await expect(page).toHaveURL(/\/dashboard\/approvals\/cards$/);
  });
});
