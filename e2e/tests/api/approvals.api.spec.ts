import { test, expect } from "@playwright/test";
import { ApiClient } from "../../utils/api-client";
import { API_BASE_URL, DEMO_OTP, DEMO_USER, MEMBER_USER } from "../../utils/env";
import { newUserPayload, uniqueSuffix } from "../../utils/data";

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
 * can be replayed, and whether the company boundary holds.
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

let admin: ApiClient;
let member: ApiClient;

test.beforeAll(async () => {
  ({ client: admin } = await ApiClient.login(DEMO_USER));
  ({ client: member } = await ApiClient.login(MEMBER_USER));
});

test.afterAll(async () => {
  await admin.dispose();
  await member.dispose();
});

/** Raises a card request as the MEMBER and returns its pending approval row. */
async function requestCardAsMember(spendLimit = 250) {
  const label = `E2E card ${uniqueSuffix()}`;

  const { card } = await member.post<{ card: Card }>("/cards", {
    label,
    type: "VIRTUAL",
    currency: "USD",
    spendLimit,
  });

  // A member has no approval power, so the card must not be usable yet.
  expect(card.status, "a member's card starts life pending, not active").toBe("PENDING");

  const { requests } = await admin.get<{ requests: ApprovalRequest[] }>("/approvals");
  const request = requests.find((r) => r.targetId === card.id);
  expect(request, `approval request was raised for card ${card.id}`).toBeTruthy();

  return { card, request: request! };
}

async function cardById(id: string): Promise<Card | undefined> {
  const { cards } = await admin.get<{ cards: Card[] }>("/cards");
  return cards.find((c) => c.id === id);
}

test.describe("Who may read the queue", () => {
  test("an admin sees their own company's pending requests", async () => {
    const { requests } = await admin.get<{ requests: ApprovalRequest[] }>("/approvals");
    expect(Array.isArray(requests)).toBe(true);
  });

  test("a MEMBER is refused the queue with 403", async () => {
    const res = await member.raw().get("/approvals");
    expect(res.status(), "a member must not see what is awaiting approval").toBe(403);
  });

  test("an anonymous caller gets 401", async ({ request }) => {
    const res = await request.get(`${API_BASE_URL}/approvals`);
    expect(res.status()).toBe(401);
  });

  test("the targetType filter narrows the queue", async () => {
    await requestCardAsMember();

    const { requests } = await admin.get<{ requests: ApprovalRequest[] }>("/approvals", {
      targetType: "BUDGET",
    });
    expect(requests.every((r) => r.targetType === "BUDGET")).toBe(true);
  });
});

test.describe("Approving", () => {
  test("an admin's approval activates the underlying card", async () => {
    const { card, request } = await requestCardAsMember();

    await admin.patch(`/approvals/${request.id}/approve`);

    expect((await cardById(card.id))?.status, "approval activates the card").toBe("ACTIVE");
  });

  test("an approved request leaves the pending queue", async () => {
    const { request } = await requestCardAsMember();
    await admin.patch(`/approvals/${request.id}/approve`);

    const { requests } = await admin.get<{ requests: ApprovalRequest[] }>("/approvals");
    expect(requests.some((r) => r.id === request.id)).toBe(false);
  });

  test("the queue names the teammate who raised the request", async () => {
    const { request } = await requestCardAsMember();
    expect(request.requester?.email).toBe(MEMBER_USER.email);
  });

  test("a decision cannot be replayed", async () => {
    const { request } = await requestCardAsMember();
    await admin.patch(`/approvals/${request.id}/approve`);

    // The lookup is scoped to PENDING, so a second decision finds nothing.
    const res = await admin.raw().patch(`/approvals/${request.id}/approve`, {});
    expect(res.status(), "an already-decided request must not be decidable again").toBe(404);
  });

  test("a MEMBER cannot approve, not even their own request", async () => {
    const { card, request } = await requestCardAsMember();

    const res = await member.raw().patch(`/approvals/${request.id}/approve`, {});
    expect(res.status()).toBe(403);
    expect((await cardById(card.id))?.status, "the card stayed pending").toBe("PENDING");
  });
});

test.describe("Rejecting", () => {
  test("a rejection marks the card rejected and records the reason", async () => {
    const { card, request } = await requestCardAsMember();
    const reason = `Not budgeted for ${uniqueSuffix()}`;

    await admin.patch(`/approvals/${request.id}/reject`, { reason });

    const rejected = await cardById(card.id);
    expect(rejected?.status).toBe("REJECTED");
    expect(rejected?.rejectionReason, "the reason is kept for the requester").toBe(reason);
  });

  test("a rejection without a reason is refused", async () => {
    const { card, request } = await requestCardAsMember();

    const res = await admin.raw().patch(`/approvals/${request.id}/reject`, {});
    expect([400, 422]).toContain(res.status());
    expect((await cardById(card.id))?.status, "no reason, no state change").toBe("PENDING");
  });

  test("an empty-string reason is refused too", async () => {
    const { request } = await requestCardAsMember();

    const res = await admin.raw().patch(`/approvals/${request.id}/reject`, { reason: "" });
    expect([400, 422]).toContain(res.status());
  });
});

test.describe("Company boundary", () => {
  test("an outside admin cannot see this company's queue contents", async ({ request }) => {
    const { request: pending } = await requestCardAsMember();

    const res = await request.post(`${API_BASE_URL}/auth/register`, {
      data: newUserPayload(DEMO_OTP),
    });
    const outsider = new ApiClient(request, (await res.json()).token);

    // A freshly registered owner is an ADMIN, so this is 200 — but of *their*
    // empty queue. The demo company's request must not appear in it.
    const { requests } = await outsider.get<{ requests: ApprovalRequest[] }>("/approvals");
    expect(requests.some((r) => r.id === pending.id)).toBe(false);
  });

  test("an outside admin cannot approve this company's request", async ({ request }) => {
    const { card, request: pending } = await requestCardAsMember();

    const res = await request.post(`${API_BASE_URL}/auth/register`, {
      data: newUserPayload(DEMO_OTP),
    });
    const outsider = new ApiClient(request, (await res.json()).token);

    const attempt = await outsider.raw().patch(`/approvals/${pending.id}/approve`, {});
    expect(
      [403, 404].includes(attempt.status()),
      `cross-company approval must be refused, got ${attempt.status()}`
    ).toBe(true);
    expect((await cardById(card.id))?.status, "the card was not activated").toBe("PENDING");
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

  test.beforeAll(async () => {
    ({ policy: originalPolicy } = await admin.get<{ policy: Policy }>("/spend-policy"));
  });

  test.afterAll(async () => {
    // Other specs share this company, so put the policy back exactly as we
    // found it — /spend-policy/reset would restore *defaults*, not these.
    await admin.patch("/spend-policy", {
      cardSpendLimitCap: num(originalPolicy.cardSpendLimitCap),
      budgetAmountCap: num(originalPolicy.budgetAmountCap),
      approvalThreshold: num(originalPolicy.approvalThreshold),
      claimFlagLimit: num(originalPolicy.claimFlagLimit) ?? 500,
    });
  });

  test("an admin can approve a request they raised themselves", async () => {
    // An admin normally bypasses approval entirely. Lowering the policy
    // threshold is the one way to force their own request into the queue.
    // The spend cap is lifted at the same time so the card below can't be
    // refused for the unrelated reason of exceeding it.
    await admin.patch("/spend-policy", {
      cardSpendLimitCap: null,
      budgetAmountCap: num(originalPolicy.budgetAmountCap),
      approvalThreshold: 1,
      claimFlagLimit: num(originalPolicy.claimFlagLimit) ?? 500,
    });

    const { card } = await admin.post<{ card: Card }>("/cards", {
      label: `E2E self-approval ${uniqueSuffix()}`,
      type: "VIRTUAL",
      currency: "USD",
      spendLimit: 500,
    });
    expect(card.status, "over the threshold, even an admin needs approval").toBe("PENDING");

    const { requests } = await admin.get<{ requests: ApprovalRequest[] }>("/approvals");
    const own = requests.find((r) => r.targetId === card.id);
    expect(own?.requester?.email).toBe(DEMO_USER.email);

    const res = await admin.raw().patch(`/approvals/${own!.id}/approve`, {});

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
    //     expect((await cardById(card.id))?.status).toBe("PENDING");
    expect(res.status()).toBe(200);
    expect((await cardById(card.id))?.status).toBe("ACTIVE");
  });
});
