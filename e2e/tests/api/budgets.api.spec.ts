import { test, expect } from "../../fixtures/test";
import { uniqueSuffix } from "../../utils/data";

/**
 * /api/budgets — spending limits, and the two rules that make them mean
 * something rather than being a number in a box:
 *
 *   1. a budget cannot be funded above the company's actual cash balance;
 *   2. the cards assigned to a budget cannot add up to more than it holds.
 *
 * Both are asserted here from the budget's side; the card's side of rule 2
 * lives in cards.api.spec.ts.
 *
 * Creating budgets runs in `fundedCompany` — the FREE plan allows two active
 * budgets, so a shared company would run out partway through the file.
 */

interface Budget {
  id: string;
  name: string;
  amount: number | string;
  spent: number | string;
  currency: string;
  status: "PENDING" | "ACTIVE" | "FROZEN" | "REJECTED";
  period: "MONTHLY" | "QUARTERLY" | "YEARLY";
}

const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

function newBudgetBody(overrides: Record<string, unknown> = {}) {
  return { name: `Budget ${uniqueSuffix()}`, amount: 1000, currency: "USD", ...overrides };
}

test.describe("POST /api/budgets", () => {
  test("an admin's own budget is active immediately", async ({ fundedCompany }) => {
    const { budget } = await fundedCompany.api.post<{ budget: Budget }>(
      "/budgets",
      newBudgetBody()
    );

    expect(budget.status).toBe("ACTIVE");
    expect(Number(budget.amount)).toBe(1000);
    expect(Number(budget.spent)).toBe(0);
    expect(budget.period).toBe("MONTHLY");
  });

  test("a MEMBER's budget lands in the approval queue instead", async ({
    memberApi,
    adminApi,
  }) => {
    const { budget } = await memberApi.post<{ budget: Budget }>("/budgets", newBudgetBody({ amount: 1 }));

    expect(budget.status).toBe("PENDING");

    const cleanup = await adminApi.raw().delete(`/budgets/${budget.id}`);
    expect(cleanup.status()).toBe(204);
  });

  test("a budget bigger than the company's cash is refused", async ({ fundedCompany }) => {
    const cash = Number(fundedCompany.account.balance);
    expect(cash).toBeGreaterThan(0);

    const res = await fundedCompany.api
      .raw()
      .post("/budgets", newBudgetBody({ amount: cash + 1000 }));

    expect(res.status()).toBe(422);
  });

  test("rejects a non-positive amount", async ({ fundedCompany }) => {
    const res = await fundedCompany.api.raw().post("/budgets", newBudgetBody({ amount: -5 }));
    expect(res.status()).toBe(400);
  });

  test("rejects an owner from outside the company", async ({ fundedCompany }) => {
    const res = await fundedCompany.api
      .raw()
      .post("/budgets", newBudgetBody({ ownerId: ABSENT_ID }));

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/owner not found/i);
  });

  test("the FREE plan stops at two active budgets", async ({ fundedCompany }) => {
    for (let i = 0; i < 2; i++) {
      await fundedCompany.api.post("/budgets", newBudgetBody({ amount: 100 }));
    }

    const res = await fundedCompany.api.raw().post("/budgets", newBudgetBody({ amount: 100 }));
    expect(res.status()).toBe(402);
  });
});

test.describe("Editing a budget is admin-only", () => {
  test("a MEMBER cannot change an amount", async ({ memberApi }) => {
    const res = await memberApi.raw().patch(`/budgets/${ABSENT_ID}`, { amount: 10 });
    expect(res.status()).toBe(403);
  });

  test("a MEMBER cannot freeze one", async ({ memberApi }) => {
    const res = await memberApi.raw().patch(`/budgets/${ABSENT_ID}/status`, { status: "FROZEN" });
    expect(res.status()).toBe(403);
  });

  test("an admin can raise the amount", async ({ fundedCompany }) => {
    const { budget } = await fundedCompany.api.post<{ budget: Budget }>(
      "/budgets",
      newBudgetBody({ amount: 500 })
    );

    const updated = await fundedCompany.api.patch<{ budget: Budget }>(`/budgets/${budget.id}`, {
      amount: 900,
    });
    expect(Number(updated.budget.amount)).toBe(900);
  });
});

test.describe("Freezing", () => {
  test("a frozen budget refuses new cards until it is unfrozen", async ({ fundedCompany }) => {
    const { budget } = await fundedCompany.api.post<{ budget: Budget }>(
      "/budgets",
      newBudgetBody({ amount: 1000 })
    );

    await fundedCompany.api.patch(`/budgets/${budget.id}/status`, { status: "FROZEN" });

    const refused = await fundedCompany.api.raw().post("/cards", {
      label: `Card ${uniqueSuffix()}`,
      type: "VIRTUAL",
      currency: "USD",
      spendLimit: 100,
      budgetId: budget.id,
    });
    expect(refused.status()).toBe(422);
    expect((await refused.json()).error).toMatch(/frozen/i);

    await fundedCompany.api.patch(`/budgets/${budget.id}/status`, { status: "ACTIVE" });

    const accepted = await fundedCompany.api.post<{ card: { budgetId?: string } }>("/cards", {
      label: `Card ${uniqueSuffix()}`,
      type: "VIRTUAL",
      currency: "USD",
      spendLimit: 100,
      budgetId: budget.id,
    });
    expect(accepted.card.budgetId).toBe(budget.id);
  });
});

test.describe("Cards may not outgrow their budget", () => {
  test("the sum of assigned spend limits is capped by the budget amount", async ({
    fundedCompany,
  }) => {
    const { budget } = await fundedCompany.api.post<{ budget: Budget }>(
      "/budgets",
      newBudgetBody({ amount: 300 })
    );

    const card = (overrides: Record<string, unknown>) => ({
      label: `Card ${uniqueSuffix()}`,
      type: "VIRTUAL",
      currency: "USD",
      budgetId: budget.id,
      ...overrides,
    });

    await fundedCompany.api.post("/cards", card({ spendLimit: 200 }));

    const overflows = await fundedCompany.api.raw().post("/cards", card({ spendLimit: 150 }));
    expect(overflows.status()).toBe(422);
    // The message names both figures, which is what makes it actionable in
    // the UI: what it would become, and what the ceiling is.
    expect((await overflows.json()).error).toMatch(/350\.00.*300\.00/);

    // Exactly filling the budget is allowed — the cap is inclusive.
    const fits = await fundedCompany.api.raw().post("/cards", card({ spendLimit: 100 }));
    expect(fits.status()).toBe(201);
  });
});

test.describe("DELETE /api/budgets/:id", () => {
  test("a budget with cards linked cannot be deleted", async ({ fundedCompany }) => {
    const { budget } = await fundedCompany.api.post<{ budget: Budget }>(
      "/budgets",
      newBudgetBody({ amount: 400 })
    );
    await fundedCompany.api.post("/cards", {
      label: `Card ${uniqueSuffix()}`,
      type: "VIRTUAL",
      currency: "USD",
      spendLimit: 50,
      budgetId: budget.id,
    });

    const res = await fundedCompany.api.raw().delete(`/budgets/${budget.id}`);
    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/unassign/i);
  });

  test("an empty budget deletes cleanly", async ({ fundedCompany }) => {
    const { budget } = await fundedCompany.api.post<{ budget: Budget }>(
      "/budgets",
      newBudgetBody({ amount: 200 })
    );

    const res = await fundedCompany.api.raw().delete(`/budgets/${budget.id}`);
    expect(res.status()).toBe(204);

    const { budgets } = await fundedCompany.api.get<{ budgets: Budget[] }>("/budgets");
    expect(budgets.map((b) => b.id)).not.toContain(budget.id);
  });
});

test.describe("Company boundary", () => {
  test("an outside company cannot read this budget", async ({ fundedCompany, outsiderApi }) => {
    const { budget } = await fundedCompany.api.post<{ budget: Budget }>(
      "/budgets",
      newBudgetBody({ amount: 100 })
    );

    const res = await outsiderApi.raw().get(`/budgets/${budget.id}`);
    expect(res.status()).toBe(404);
  });

  test("/budgets refuses an anonymous caller", async ({ anonApi }) => {
    const res = await anonApi.raw().get("/budgets");
    expect(res.status()).toBe(401);
  });
});
