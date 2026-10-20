import { test, expect } from "../../fixtures/test";
import { ApiClient } from "../../utils/api-client";
import { DEMO_USER, MEMBER_USER } from "../../utils/env";
import { uniqueSuffix } from "../../utils/data";

/**
 * /api/approvals — the company-side maker/checker queue.
 *
 * A MEMBER has no approval power, so anything they create (a card, a budget)
 * is written as PENDING and raises an approval request; a company ADMIN then
 * approves or rejects it, which is what flips the underlying record to ACTIVE
 * or REJECTED.
 *
 * This is an authorisation control, not a feature, so most of what's below is
 * negative testing: who may see the queue, who may decide, whether a decision
 * can be replayed, and whether the company boundary holds. The fixture names
 * carry that meaning — `memberApi` is the maker, `adminApi` the checker, and
 * `outsiderApi` a different company entirely.
 */

interface ApprovalRequest {
  id: string;
  targetType: "CARD" | "BUDGET";
  targetId: string;
  metadata: Record<string, unknown>;
  requester: { id: string; name: string; email: string } | null;
}

interface Card {
  id: string;
  label: string;
  status: "ACTIVE" | "PENDING" | "FROZEN" | "CANCELLED" | "REJECTED";
  rejectionReason?: string | null;
}

/**
 * Every card these specs create lands in the SEEDED demo company, and an
 * approved or still-pending card counts against the plan's active-card cap
 * (15 on Pro). Without cleanup each run leaves a few behind, and after a
 * handful of runs `POST /cards` starts answering 402 for reasons that have
 * nothing to do with approvals. So every card is tracked and hard-deleted
 * (DELETE /cards/:id, admin-only, testing-only) once its test is done.
 */
const CARD_LABEL_PREFIX = "E2E approval card";
const createdCardIds: string[] = [];

/**
 * Leftovers from runs that predate the cleanup above (or that were killed
 * mid-test). Only cards older than this are touched, so a card another worker
 * is using right now — spend.spec.ts creates "E2E card …" labels too, and
 * deletes them itself — is never pulled out from under it.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;
const LEFTOVER_PREFIXES = [CARD_LABEL_PREFIX, "E2E card ", "E2E self-approval "];

test.beforeAll(async ({ adminApi }) => {
  const { cards } = await adminApi.get<{ cards: (Card & { createdAt?: string })[] }>("/cards");
  const cutoff = Date.now() - STALE_AFTER_MS;
  const stale = cards.filter(
    (c) =>
      LEFTOVER_PREFIXES.some((prefix) => c.label.startsWith(prefix)) &&
      c.createdAt !== undefined &&
      new Date(c.createdAt).getTime() < cutoff
  );
  for (const card of stale) {
    await adminApi.raw().delete(`/cards/${card.id}`);
  }
});

test.afterEach(async ({ adminApi }) => {
  while (createdCardIds.length > 0) {
    const id = createdCardIds.pop()!;
    await adminApi.raw().delete(`/cards/${id}`);
  }
});

/** Raises a card request as the MEMBER and returns its pending approval row. */
async function requestCardAsMember(
  adminApi: ApiClient,
  memberApi: ApiClient,
  spendLimit = 250
) {
  const label = `${CARD_LABEL_PREFIX} ${uniqueSuffix()}`;

  const { card } = await memberApi.post<{ card: Card }>("/cards", {
    label,
    type: "VIRTUAL",
    currency: "USD",
    spendLimit,
  });
  createdCardIds.push(card.id);

  // A member has no approval power, so the card must not be usable yet.
  expect(card.status, "a member's card starts life pending, not active").toBe("PENDING");

  const { requests } = await adminApi.get<{ requests: ApprovalRequest[] }>("/approvals");
  const request = requests.find((r) => r.targetId === card.id);
  expect(request, `approval request was raised for card ${card.id}`).toBeTruthy();

  return { card, request: request! };
}

async function cardById(adminApi: ApiClient, id: string): Promise<Card | undefined> {
  const { cards } = await adminApi.get<{ cards: Card[] }>("/cards");
  return cards.find((c) => c.id === id);
}

test.describe("Who may read the queue", () => {
  test("an admin sees their own company's pending requests", async ({ adminApi }) => {
    const { requests } = await adminApi.get<{ requests: ApprovalRequest[] }>("/approvals");
    expect(Array.isArray(requests)).toBe(true);
  });

  test("a MEMBER is refused the queue with 403", async ({ memberApi }) => {
    const res = await memberApi.raw().get("/approvals");
    expect(res.status(), "a member must not see what is awaiting approval").toBe(403);
  });

  test("an anonymous caller gets 401", async ({ anonApi }) => {
    const res = await anonApi.raw().get("/approvals");
    expect(res.status()).toBe(401);
  });

  test("the targetType filter narrows the queue", async ({ adminApi, memberApi }) => {
    await requestCardAsMember(adminApi, memberApi);

    const { requests } = await adminApi.get<{ requests: ApprovalRequest[] }>("/approvals", {
      targetType: "BUDGET",
    });
    expect(requests.every((r) => r.targetType === "BUDGET")).toBe(true);
  });
});

test.describe("Approving", () => {
  test("an admin's approval activates the underlying card", async ({ adminApi, memberApi }) => {
    const { card, request } = await requestCardAsMember(adminApi, memberApi);

    await adminApi.patch(`/approvals/${request.id}/approve`);

    expect((await cardById(adminApi, card.id))?.status, "approval activates the card").toBe(
      "ACTIVE"
    );
  });

  test("an approved request leaves the pending queue", async ({ adminApi, memberApi }) => {
    const { request } = await requestCardAsMember(adminApi, memberApi);
    await adminApi.patch(`/approvals/${request.id}/approve`);

    const { requests } = await adminApi.get<{ requests: ApprovalRequest[] }>("/approvals");
    expect(requests.some((r) => r.id === request.id)).toBe(false);
  });

  test("the queue names the teammate who raised the request", async ({
    adminApi,
    memberApi,
  }) => {
    const { request } = await requestCardAsMember(adminApi, memberApi);
    expect(request.requester?.email).toBe(MEMBER_USER.email);
  });

  test("a decision cannot be replayed", async ({ adminApi, memberApi }) => {
    const { request } = await requestCardAsMember(adminApi, memberApi);
    await adminApi.patch(`/approvals/${request.id}/approve`);

    // The lookup is scoped to PENDING, so a second decision finds nothing.
    const res = await adminApi.raw().patch(`/approvals/${request.id}/approve`, {});
    expect(res.status(), "an already-decided request must not be decidable again").toBe(404);
  });

  test("a MEMBER cannot approve, not even their own request", async ({
    adminApi,
    memberApi,
  }) => {
    const { card, request } = await requestCardAsMember(adminApi, memberApi);

    const res = await memberApi.raw().patch(`/approvals/${request.id}/approve`, {});
    expect(res.status()).toBe(403);
    expect((await cardById(adminApi, card.id))?.status, "the card stayed pending").toBe(
      "PENDING"
    );
  });
});

test.describe("Rejecting", () => {
  test("a rejection marks the card rejected and records the reason", async ({
    adminApi,
    memberApi,
  }) => {
    const { card, request } = await requestCardAsMember(adminApi, memberApi);
    const reason = `Not budgeted for ${uniqueSuffix()}`;

    await adminApi.patch(`/approvals/${request.id}/reject`, { reason });

    const rejected = await cardById(adminApi, card.id);
    expect(rejected?.status).toBe("REJECTED");
    expect(rejected?.rejectionReason, "the reason is kept for the requester").toBe(reason);
  });

  test("a rejection without a reason is refused", async ({ adminApi, memberApi }) => {
    const { card, request } = await requestCardAsMember(adminApi, memberApi);

    const res = await adminApi.raw().patch(`/approvals/${request.id}/reject`, {});
    expect([400, 422]).toContain(res.status());
    expect((await cardById(adminApi, card.id))?.status, "no reason, no state change").toBe(
      "PENDING"
    );
  });

  test("an empty-string reason is refused too", async ({ adminApi, memberApi }) => {
    const { request } = await requestCardAsMember(adminApi, memberApi);

    const res = await adminApi.raw().patch(`/approvals/${request.id}/reject`, { reason: "" });
    expect([400, 422]).toContain(res.status());
  });
});

test.describe("Company boundary", () => {
  test("an outside admin cannot see this company's queue contents", async ({
    adminApi,
    memberApi,
    outsiderApi,
  }) => {
    const { request: pending } = await requestCardAsMember(adminApi, memberApi);

    // A freshly registered owner is an ADMIN, so this is 200 — but of *their*
    // empty queue. The demo company's request must not appear in it.
    const { requests } = await outsiderApi.get<{ requests: ApprovalRequest[] }>("/approvals");
    expect(requests.some((r) => r.id === pending.id)).toBe(false);
  });

  test("an outside admin cannot approve this company's request", async ({
    adminApi,
    memberApi,
    outsiderApi,
  }) => {
    const { card, request: pending } = await requestCardAsMember(adminApi, memberApi);

    const attempt = await outsiderApi.raw().patch(`/approvals/${pending.id}/approve`, {});
    expect(
      [403, 404].includes(attempt.status()),
      `cross-company approval must be refused, got ${attempt.status()}`
    ).toBe(true);
    expect((await cardById(adminApi, card.id))?.status, "the card was not activated").toBe(
      "PENDING"
    );
  });
});

/**
 * Separation of duties — the part of maker/checker that is currently NOT
 * enforced. Read the comment inside before changing anything here.
 */
test.describe("Maker and checker are the same person", () => {
  /**
   * The policy row is returned straight from Prisma, so every Decimal column
   * arrives as a JSON *string* ("500") — while PATCH validates them with
   * z.number(). Reading a value and writing it straight back would 400, hence
   * `num()` below.
   */
  interface Policy {
    cardSpendLimitCap: string | number | null;
    budgetAmountCap: string | number | null;
    approvalThreshold: string | number | null;
    claimFlagLimit: string | number;
  }

  const num = (value: string | number | null | undefined): number | null =>
    value === null || value === undefined ? null : Number(value);

  let originalPolicy: Policy;

  // `adminApi` is worker-scoped, which is what makes it legal to use from a
  // beforeAll hook — Playwright only injects worker fixtures here.
  test.beforeAll(async ({ adminApi }) => {
    ({ policy: originalPolicy } = await adminApi.get<{ policy: Policy }>("/spend-policy"));
  });

  test.afterAll(async ({ adminApi }) => {
    // Other specs share this company, so put the policy back exactly as we
    // found it — /spend-policy/reset would restore *defaults*, not these.
    await adminApi.patch("/spend-policy", {
      cardSpendLimitCap: num(originalPolicy.cardSpendLimitCap),
      budgetAmountCap: num(originalPolicy.budgetAmountCap),
      approvalThreshold: num(originalPolicy.approvalThreshold),
      claimFlagLimit: num(originalPolicy.claimFlagLimit) ?? 500,
    });
  });

  test("an admin can approve a request they raised themselves", async ({ adminApi }) => {
    // An admin normally bypasses approval entirely. Lowering the policy
    // threshold is the one way to force their own request into the queue.
    // The spend cap is lifted at the same time so the card below can't be
    // refused for the unrelated reason of exceeding it.
    await adminApi.patch("/spend-policy", {
      cardSpendLimitCap: null,
      budgetAmountCap: num(originalPolicy.budgetAmountCap),
      approvalThreshold: 1,
      claimFlagLimit: num(originalPolicy.claimFlagLimit) ?? 500,
    });

    const { card } = await adminApi.post<{ card: Card }>("/cards", {
      label: `E2E self-approval ${uniqueSuffix()}`,
      type: "VIRTUAL",
      currency: "USD",
      spendLimit: 500,
    });
    createdCardIds.push(card.id);
    expect(card.status, "over the threshold, even an admin needs approval").toBe("PENDING");

    const { requests } = await adminApi.get<{ requests: ApprovalRequest[] }>("/approvals");
    const own = requests.find((r) => r.targetId === card.id);
    expect(own?.requester?.email).toBe(DEMO_USER.email);

    const res = await adminApi.raw().patch(`/approvals/${own!.id}/approve`, {});

    // ⚠️ This assertion DOCUMENTS current behaviour; it is not an endorsement.
    //
    // approval.service.ts checks that the request is pending and belongs to
    // the caller's company, but never that reviewerId !== requesterId. So the
    // same admin who tripped the policy threshold can clear it, and the
    // threshold becomes a speed bump rather than a control.
    //
    // Whether that is acceptable is a product decision — with a single admin
    // on the account, blocking self-approval would deadlock the queue. If the
    // team decides separation of duties must hold, enforce it in
    // approveRequest() and flip the two expectations below to:
    //     expect(res.status()).toBe(403);
    //     expect((await cardById(adminApi, card.id))?.status).toBe("PENDING");
    expect(res.status()).toBe(200);
    expect((await cardById(adminApi, card.id))?.status).toBe("ACTIVE");
  });
});
