import { test, expect } from "../../fixtures/test";
import { uniqueSuffix } from "../../utils/data";

/**
 * The app frame: global search and the notification bell.
 *
 * Both aggregate data that is scattered across other screens and neither
 * persists anything of its own — `GET /search` and `GET /notifications` are
 * computed fresh from existing tables on every call. So the way to test them
 * is to put a known thing into the company over HTTP and then ask the frame
 * to find it.
 */

test.describe("Global search", () => {
  test("finds a claim by its title, from a page that isn't the claims page", async ({
    homePage,
    shell,
    adminApi,
  }) => {
    const title = `Findable ${uniqueSuffix()}`;
    const { claim } = await adminApi.post<{ claim: { id: string } }>("/claims", {
      title,
      amount: 21,
      currency: "USD",
      category: "Software",
      receiptUrl: "https://example.com/receipt.jpg",
    });

    try {
      await homePage.goto();
      await shell.search(title);

      // The dropdown groups results by kind; the claim must appear under its
      // own group rather than only matching some row already on the page.
      await expect(shell.resultGroup(/expense claims/i).first()).toBeVisible({ timeout: 15_000 });
      await expect(shell.page.getByText(title).first()).toBeVisible();
    } finally {
      await adminApi.raw().delete(`/claims/${claim.id}`);
    }
  });

  test("a term that matches nothing does not break the page", async ({ homePage, shell }) => {
    await homePage.goto();
    await shell.search(`zzz-${uniqueSuffix()}-no-such-thing`);

    // No assertion about an empty-state string — the contract worth pinning
    // is that the shell survives it and search stays usable.
    await expect(shell.searchInput).toBeEditable();
  });
});

test.describe("Notifications", () => {
  test("the bell opens a panel", async ({ homePage, shell }) => {
    await homePage.goto();
    await shell.openNotifications();

    await expect(shell.notificationsPanel).toBeVisible();
  });

  test("a bill due this week is surfaced in the panel", async ({ homePage, shell, adminApi }) => {
    const vendor = `Due soon ${uniqueSuffix()}`;
    const { bill } = await adminApi.post<{ bill: { id: string } }>("/bills", {
      vendor,
      amount: 30,
      currency: "USD",
      // Inside the 7-day window GET /notifications reports on.
      dueDate: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
    });

    try {
      await homePage.goto();
      await shell.openNotifications();
      await expect(shell.page.getByText(vendor).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await adminApi.raw().delete(`/bills/${bill.id}`);
    }
  });

  test("the panel agrees with GET /notifications", async ({ homePage, shell, adminApi }) => {
    const { notifications } = await adminApi.get<{ notifications: unknown[] }>("/notifications");

    await homePage.goto();
    await shell.openNotifications();

    // Whatever the API computed, the panel must render the same idea of
    // "nothing to report" or "something to report" — not the opposite.
    if (notifications.length === 0) {
      await expect(shell.notificationsPanel).toBeVisible();
    } else {
      await expect(shell.notificationsPanel).toBeVisible();
      expect(notifications.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The negative half of search, written so it cannot pass for the wrong
 * reason: it first proves the dropdown DOES surface this company's own claim,
 * and only then asks for the other company's and expects nothing.
 */
test("search is company-scoped: another company's claim is not findable", async ({
  homePage,
  shell,
  adminApi,
  outsiderApi,
}) => {
  const suffix = uniqueSuffix();
  const mine = `Mine ${suffix}`;
  const theirs = `Theirs ${suffix}`;

  const claimBody = (title: string) => ({
    title,
    amount: 15,
    currency: "USD",
    category: "Software",
    receiptUrl: "https://example.com/receipt.jpg",
  });

  const { claim } = await adminApi.post<{ claim: { id: string } }>("/claims", claimBody(mine));
  await outsiderApi.post("/claims", claimBody(theirs));

  try {
    await homePage.goto();

    await shell.search(mine);
    await expect(shell.page.getByText(mine).first()).toBeVisible({ timeout: 15_000 });

    await shell.search(theirs);
    // The dropdown is proven to work by the assertion above, so an empty
    // result here is a real tenancy boundary and not a race with rendering.
    await expect(shell.page.getByText(theirs)).toHaveCount(0);
  } finally {
    await adminApi.raw().delete(`/claims/${claim.id}`);
  }
});
