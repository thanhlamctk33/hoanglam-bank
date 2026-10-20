import { test, expect } from "../../fixtures/test";
import { ApiClient } from "../../utils/api-client";
import { uniqueSuffix } from "../../utils/data";

/**
 * The Spend screens, driven as a signed-in Admin.
 *
 * These specs arrange over HTTP and assert through the UI: the thing under
 * test is "does this screen show what the company actually has", not "can
 * the backend create a card" — that is cards.api.spec.ts's job, where a
 * failure points at one route instead of at a whole page.
 *
 * Every object created here is deleted again in the same spec. The UI specs
 * share the seeded demo company, and cards and budgets are both capped by the
 * subscription plan, so a spec that leaves its litter behind would slowly
 * push the company toward a 402 that has nothing to do with what it asserts.
 */

interface Card {
  id: string;
  label: string;
  status: string;
}

interface Budget {
  id: string;
  name: string;
}

/** Creates a card, hands it to the test, then removes it whatever happens. */
async function withCard(
  api: ApiClient,
  run: (card: Card) => Promise<void>,
  spendLimit = 250
): Promise<void> {
  const { card } = await api.post<{ card: Card }>("/cards", {
    label: `E2E card ${uniqueSuffix()}`,
    type: "VIRTUAL",
    currency: "USD",
    spendLimit,
  });
  try {
    await run(card);
  } finally {
    await api.raw().delete(`/cards/${card.id}`);
  }
}

test.describe("Company cards", () => {
  test("shows a card that was just issued", async ({ cardsPage, adminApi }) => {
    await withCard(adminApi, async (card) => {
      await cardsPage.goto();
      await expect(cardsPage.card(card.label)).toBeVisible();
    });
  });

  test("an admin is offered the issuing action, not the request one", async ({ cardsPage }) => {
    await cardsPage.goto();

    // The wording is the permission: an Admin issues, a Member requests.
    await expect(cardsPage.primaryAction).toBeVisible();
    await expect(cardsPage.primaryAction).toHaveText(/issue new card/i);
  });

  test("the summary tiles render", async ({ cardsPage }) => {
    await cardsPage.goto();
    await expect(cardsPage.activeCardsTile).toBeVisible();
  });
});

test.describe("Spending limits", () => {
  test("shows a budget that was just created, and its total", async ({
    budgetsPage,
    adminApi,
  }) => {
    const name = `E2E budget ${uniqueSuffix()}`;
    const { budget } = await adminApi.post<{ budget: Budget }>("/budgets", {
      name,
      amount: 100,
      currency: "USD",
    });

    try {
      await budgetsPage.goto();
      await expect(budgetsPage.budget(name)).toBeVisible();
      await expect(budgetsPage.totalBudgetedTile).toBeVisible();
    } finally {
      await adminApi.raw().delete(`/budgets/${budget.id}`);
    }
  });

  test("an admin is offered the create action, not the request one", async ({ budgetsPage }) => {
    await budgetsPage.goto();

    await expect(budgetsPage.primaryAction).toBeVisible();
    await expect(budgetsPage.primaryAction).toHaveText(/new budget/i);
  });
});

test.describe("Expense claims", () => {
  test("shows a claim that was just filed", async ({ claimsPage, adminApi }) => {
    const title = `E2E claim ${uniqueSuffix()}`;
    const { claim } = await adminApi.post<{ claim: { id: string } }>("/claims", {
      title,
      amount: 12.34,
      currency: "USD",
      category: "Software",
      receiptUrl: "https://example.com/receipt.jpg",
    });

    try {
      await claimsPage.goto();
      await expect(claimsPage.claim(title)).toBeVisible();
    } finally {
      await adminApi.raw().delete(`/claims/${claim.id}`);
    }
  });
});

test.describe("Vendor bills", () => {
  test("shows a bill that was just created", async ({ vendorBillsPage, adminApi }) => {
    const vendor = `E2E vendor ${uniqueSuffix()}`;
    const { bill } = await adminApi.post<{ bill: { id: string } }>("/bills", {
      vendor,
      amount: 75,
      currency: "USD",
      dueDate: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
    });

    try {
      await vendorBillsPage.goto();
      await expect(vendorBillsPage.bill(vendor)).toBeVisible();
    } finally {
      await adminApi.raw().delete(`/bills/${bill.id}`);
    }
  });
});
