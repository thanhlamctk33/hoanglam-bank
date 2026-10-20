import { test, expect } from "../../fixtures/test";
import { uniqueSuffix } from "../../utils/data";

/**
 * /api/cards — issuing, freezing, controls, and the simulated card network.
 *
 * Cards are the one Spend object with a real enforcement path: this app has
 * no card network, so `POST /cards/:id/simulate-purchase` IS the network, and
 * the channel/category/limit checks are only real if something exercises
 * them. Half of this file does exactly that.
 *
 * Everything that creates a card runs inside `fundedCompany` — a company of
 * this test's own — because the FREE plan caps active cards at 3 and a shared
 * company would start handing out 402s in run order.
 */

interface Card {
  id: string;
  label: string;
  type: "VIRTUAL" | "PHYSICAL" | "PREPAID";
  status: "PENDING" | "ACTIVE" | "FROZEN" | "CANCELLED" | "REJECTED";
  currency: string;
  spendLimit: number | string;
  spent: number | string;
  last4: string;
  allowOnline: boolean;
  allowAtm: boolean;
  blockedCategories: string | null;
}

/** A uuid that is syntactically valid but belongs to nobody. */
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

function newCardBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    label: `Card ${uniqueSuffix()}`,
    type: "VIRTUAL",
    currency: "USD",
    spendLimit: 500,
    ...overrides,
  };
}

test.describe("POST /api/cards", () => {
  test("an admin's own card is active immediately, with controls open by default", async ({
    fundedCompany,
  }) => {
    const { card } = await fundedCompany.api.post<{ card: Card }>("/cards", newCardBody());

    expect(card.status).toBe("ACTIVE");
    expect(card.last4).toHaveLength(4);
    expect(Number(card.spendLimit)).toBe(500);
    expect(Number(card.spent)).toBe(0);
    // Controls start permissive — the blocked-category list is what a spec
    // has to close explicitly before simulate-purchase can refuse anything.
    expect(card.allowOnline).toBe(true);
    expect(card.allowAtm).toBe(true);
  });

  test("a MEMBER's card lands in the approval queue instead", async ({
    memberApi,
    adminApi,
  }) => {
    const { card } = await memberApi.post<{ card: Card }>("/cards", newCardBody());

    expect(card.status).toBe("PENDING");

    // Clean up through the ADMIN: DELETE /cards/:id is admin-only, so asking
    // the member to tidy up after itself would 403 and quietly leave a
    // pending request in the seeded company for every future run.
    const cleanup = await adminApi.raw().delete(`/cards/${card.id}`);
    expect(cleanup.status()).toBe(204);
  });

  test("rejects a non-positive spend limit", async ({ fundedCompany }) => {
    const res = await fundedCompany.api.raw().post("/cards", newCardBody({ spendLimit: 0 }));
    expect(res.status()).toBe(400);
  });

  test("rejects a card type the schema doesn't know", async ({ fundedCompany }) => {
    const res = await fundedCompany.api.raw().post("/cards", newCardBody({ type: "GOLD" }));
    expect(res.status()).toBe(400);
  });

  test("rejects a budget that belongs to nobody", async ({ fundedCompany }) => {
    const res = await fundedCompany.api
      .raw()
      .post("/cards", newCardBody({ budgetId: ABSENT_ID }));

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/budget not found/i);
  });

  test("a prepaid card without a funding account is refused", async ({ fundedCompany }) => {
    const res = await fundedCompany.api.raw().post("/cards", newCardBody({ type: "PREPAID" }));

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/cash account/i);
  });

  test("the FREE plan stops at three active cards", async ({ fundedCompany }) => {
    for (let i = 0; i < 3; i++) {
      const { card } = await fundedCompany.api.post<{ card: Card }>("/cards", newCardBody());
      expect(card.status).toBe("ACTIVE");
    }

    const res = await fundedCompany.api.raw().post("/cards", newCardBody());
    // 402 Payment Required — the plan is the thing standing in the way, and
    // the status code says "upgrade", not "you got the request wrong".
    expect(res.status()).toBe(402);
  });
});

test.describe("PATCH /api/cards/:id/status", () => {
  test("freezing asks for the password again, and a wrong one changes nothing", async ({
    fundedCompany,
  }) => {
    const { card } = await fundedCompany.api.post<{ card: Card }>("/cards", newCardBody());

    const refused = await fundedCompany.api
      .raw()
      .patch(`/cards/${card.id}/status`, { status: "FROZEN", password: "not-the-password" });
    expect(refused.status()).toBe(401);

    const { cards } = await fundedCompany.api.get<{ cards: Card[] }>("/cards");
    expect(cards.find((c) => c.id === card.id)?.status).toBe("ACTIVE");
  });

  test("freezing and unfreezing with the right password works", async ({ fundedCompany }) => {
    const { card } = await fundedCompany.api.post<{ card: Card }>("/cards", newCardBody());
    const password = fundedCompany.password;

    const frozen = await fundedCompany.api.patch<{ card: Card }>(`/cards/${card.id}/status`, {
      status: "FROZEN",
      password,
    });
    expect(frozen.card.status).toBe("FROZEN");

    const thawed = await fundedCompany.api.patch<{ card: Card }>(`/cards/${card.id}/status`, {
      status: "ACTIVE",
      password,
    });
    expect(thawed.card.status).toBe("ACTIVE");
  });

  test("a frozen card cannot be used", async ({ fundedCompany }) => {
    const { card } = await fundedCompany.api.post<{ card: Card }>("/cards", newCardBody());
    await fundedCompany.api.patch(`/cards/${card.id}/status`, {
      status: "FROZEN",
      password: fundedCompany.password,
    });

    const res = await fundedCompany.api
      .raw()
      .post(`/cards/${card.id}/simulate-purchase`, { amount: 10, channel: "ONLINE" });

    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/frozen/i);
  });
});

test.describe("Card controls are admin-only", () => {
  test("a MEMBER is refused before the card id is even looked at", async ({ memberApi }) => {
    const res = await memberApi.raw().patch(`/cards/${ABSENT_ID}/controls`, {
      allowOnline: false,
      allowAtm: false,
      blockedCategories: [],
    });

    // requireCompanyAdmin runs ahead of the handler, so this is 403 rather
    // than the 404 the unknown id would otherwise earn — which is the point:
    // authorisation is decided before existence is leaked.
    expect(res.status()).toBe(403);
  });
});

test.describe("POST /api/cards/:id/simulate-purchase", () => {
  test("an approved purchase increments spent by exactly the amount", async ({
    fundedCompany,
  }) => {
    const { card } = await fundedCompany.api.post<{ card: Card }>("/cards", newCardBody());

    const first = await fundedCompany.api.post<{ card: Card }>(
      `/cards/${card.id}/simulate-purchase`,
      { amount: 120.5, channel: "IN_STORE", merchantCategory: "Software" }
    );
    expect(Number(first.card.spent)).toBeCloseTo(120.5, 2);

    const second = await fundedCompany.api.post<{ card: Card }>(
      `/cards/${card.id}/simulate-purchase`,
      { amount: 9.5, channel: "IN_STORE" }
    );
    expect(Number(second.card.spent)).toBeCloseTo(130, 2);
  });

  test("turning online purchases off refuses an online purchase", async ({ fundedCompany }) => {
    const { card } = await fundedCompany.api.post<{ card: Card }>("/cards", newCardBody());
    await fundedCompany.api.patch(`/cards/${card.id}/controls`, {
      allowOnline: false,
      allowAtm: true,
      blockedCategories: [],
    });

    const res = await fundedCompany.api
      .raw()
      .post(`/cards/${card.id}/simulate-purchase`, { amount: 5, channel: "ONLINE" });
    expect(res.status()).toBe(403);

    // The same card still takes the purchase through a channel that is on.
    const inStore = await fundedCompany.api.post<{ card: Card }>(
      `/cards/${card.id}/simulate-purchase`,
      { amount: 5, channel: "IN_STORE" }
    );
    expect(Number(inStore.card.spent)).toBeCloseTo(5, 2);
  });

  test("turning ATM off refuses a withdrawal", async ({ fundedCompany }) => {
    const { card } = await fundedCompany.api.post<{ card: Card }>("/cards", newCardBody());
    await fundedCompany.api.patch(`/cards/${card.id}/controls`, {
      allowOnline: true,
      allowAtm: false,
      blockedCategories: [],
    });

    const res = await fundedCompany.api
      .raw()
      .post(`/cards/${card.id}/simulate-purchase`, { amount: 20, channel: "ATM" });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toMatch(/atm/i);
  });

  test("a blocked merchant category is refused while others still pass", async ({
    fundedCompany,
  }) => {
    const { card } = await fundedCompany.api.post<{ card: Card }>("/cards", newCardBody());
    await fundedCompany.api.patch(`/cards/${card.id}/controls`, {
      allowOnline: true,
      allowAtm: true,
      blockedCategories: ["Gambling"],
    });

    const blocked = await fundedCompany.api.raw().post(`/cards/${card.id}/simulate-purchase`, {
      amount: 30,
      channel: "ONLINE",
      merchantCategory: "Gambling",
    });
    expect(blocked.status()).toBe(403);

    const allowed = await fundedCompany.api.post<{ card: Card }>(
      `/cards/${card.id}/simulate-purchase`,
      { amount: 30, channel: "ONLINE", merchantCategory: "Software" }
    );
    expect(Number(allowed.card.spent)).toBeCloseTo(30, 2);
  });

  test("the spend limit is a ceiling, and a refused purchase spends nothing", async ({
    fundedCompany,
  }) => {
    const { card } = await fundedCompany.api.post<{ card: Card }>(
      "/cards",
      newCardBody({ spendLimit: 100 })
    );

    await fundedCompany.api.post(`/cards/${card.id}/simulate-purchase`, {
      amount: 100,
      channel: "IN_STORE",
    });

    const overTheTop = await fundedCompany.api
      .raw()
      .post(`/cards/${card.id}/simulate-purchase`, { amount: 0.01, channel: "IN_STORE" });
    expect(overTheTop.status()).toBe(422);

    const { cards } = await fundedCompany.api.get<{ cards: Card[] }>("/cards");
    // The refusal must not have moved the counter — a 422 that still spent
    // the money would be worse than a 500 that didn't.
    expect(Number(cards.find((c) => c.id === card.id)?.spent)).toBeCloseTo(100, 2);
  });
});

test.describe("Company boundary", () => {
  test("an outside company cannot see this company's cards", async ({
    fundedCompany,
    outsiderApi,
  }) => {
    const { card } = await fundedCompany.api.post<{ card: Card }>("/cards", newCardBody());

    const { cards } = await outsiderApi.get<{ cards: Card[] }>("/cards");
    expect(cards.map((c) => c.id)).not.toContain(card.id);
  });

  test("an outside admin cannot freeze this company's card", async ({
    fundedCompany,
    outsiderApi,
  }) => {
    const { card } = await fundedCompany.api.post<{ card: Card }>("/cards", newCardBody());

    const res = await outsiderApi
      .raw()
      .patch(`/cards/${card.id}/status`, { status: "FROZEN", password: fundedCompany.password });
    expect(res.status()).toBe(404);

    const { cards } = await fundedCompany.api.get<{ cards: Card[] }>("/cards");
    expect(cards.find((c) => c.id === card.id)?.status).toBe("ACTIVE");
  });

  test("every /cards route refuses an anonymous caller", async ({ anonApi }) => {
    const calls = [
      anonApi.raw().get("/cards"),
      anonApi.raw().post("/cards", newCardBody()),
      anonApi.raw().patch(`/cards/${ABSENT_ID}/status`, { status: "FROZEN", password: "x" }),
      anonApi.raw().post(`/cards/${ABSENT_ID}/simulate-purchase`, { amount: 1, channel: "ONLINE" }),
    ];

    for (const res of await Promise.all(calls)) {
      expect(res.status()).toBe(401);
    }
  });
});
