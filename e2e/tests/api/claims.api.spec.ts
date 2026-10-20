import { test, expect } from "../../fixtures/test";
import { uniqueSuffix } from "../../utils/data";

/**
 * /api/claims — expense claims and who may decide them.
 *
 * The interesting rule is the split: anyone in the company may FILE a claim,
 * but only an admin may approve or reject one, and a MEMBER may not approve
 * even their own. Like cards and budgets, a claim filed by someone with
 * approval power (an ADMIN) is approved on the spot — only a MEMBER's claim
 * waits in PENDING (see claims.service.ts, hasApprovalPower). The FREE plan also caps claims at five per calendar month,
 * which is asserted here from a company that starts the test at zero.
 */

interface Claim {
  id: string;
  title: string;
  amount: number | string;
  currency: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  batchId?: string | null;
}

const ABSENT_ID = "00000000-0000-4000-8000-000000000000";
const RECEIPT = "https://example.com/receipt.jpg";

function newClaimBody(overrides: Record<string, unknown> = {}) {
  return {
    title: `Claim ${uniqueSuffix()}`,
    amount: 42.5,
    currency: "USD",
    category: "Software",
    receiptUrl: RECEIPT,
    ...overrides,
  };
}

test.describe("POST /api/claims", () => {
  test("an admin's own claim is approved straight away", async ({ fundedCompany }) => {
    const { claim } = await fundedCompany.api.post<{ claim: Claim }>("/claims", newClaimBody());

    expect(claim.status).toBe("APPROVED");
    expect(Number(claim.amount)).toBeCloseTo(42.5, 2);
  });

  test("a MEMBER's claim waits as pending", async ({ memberApi, adminApi }) => {
    const { claim } = await memberApi.post<{ claim: Claim }>("/claims", newClaimBody({ amount: 1 }));

    expect(claim.status).toBe("PENDING");

    // Tidied away through the admin so the seeded company doesn't fill up.
    await adminApi.raw().delete(`/claims/${claim.id}`);
  });

  test("a receipt is required, and it has to be a URL", async ({ fundedCompany }) => {
    const missing = await fundedCompany.api.raw().post("/claims", {
      title: "No receipt",
      amount: 10,
      currency: "USD",
    });
    expect(missing.status()).toBe(400);

    const notAUrl = await fundedCompany.api
      .raw()
      .post("/claims", newClaimBody({ receiptUrl: "receipt.jpg" }));
    expect(notAUrl.status()).toBe(400);
  });

  test("rejects a non-positive amount", async ({ fundedCompany }) => {
    const res = await fundedCompany.api.raw().post("/claims", newClaimBody({ amount: 0 }));
    expect(res.status()).toBe(400);
  });

  test("the FREE plan stops at five claims a month", async ({ fundedCompany }) => {
    for (let i = 0; i < 5; i++) {
      const { claim } = await fundedCompany.api.post<{ claim: Claim }>(
        "/claims",
        newClaimBody({ amount: 1 })
      );
      expect(claim.status).toBe("APPROVED");
    }

    const res = await fundedCompany.api.raw().post("/claims", newClaimBody({ amount: 1 }));
    expect(res.status()).toBe(402);
  });
});

test.describe("POST /api/claims/bulk", () => {
  test("files a batch and gives it one batch id", async ({ fundedCompany }) => {
    const { claims, batchId } = await fundedCompany.api.post<{ claims: Claim[]; batchId: string }>(
      "/claims/bulk",
      {
        claims: [
          newClaimBody({ amount: 5 }),
          newClaimBody({ amount: 6 }),
          newClaimBody({ amount: 7 }),
        ],
      }
    );

    expect(claims).toHaveLength(3);
    expect(batchId).toBeTruthy();
    expect(claims.every((c) => c.status === "APPROVED")).toBe(true);
  });

  test("an empty batch is refused", async ({ fundedCompany }) => {
    const res = await fundedCompany.api.raw().post("/claims/bulk", { claims: [] });
    expect(res.status()).toBe(400);
  });

  test("a whole batch can be decided in one call", async ({ fundedCompany }) => {
    const { batchId } = await fundedCompany.api.post<{ claims: Claim[]; batchId: string }>(
      "/claims/bulk",
      { claims: [newClaimBody({ amount: 5 }), newClaimBody({ amount: 6 })] }
    );

    await fundedCompany.api.patch(`/claims/batch/${batchId}/status`, { status: "APPROVED" });

    const { claims } = await fundedCompany.api.get<{ claims: Claim[] }>("/claims");
    const inBatch = claims.filter((c) => c.batchId === batchId);
    expect(inBatch).toHaveLength(2);
    expect(inBatch.every((c) => c.status === "APPROVED")).toBe(true);
  });
});

test.describe("Deciding a claim is admin-only", () => {
  test("an admin approves and the decision sticks", async ({ fundedCompany }) => {
    const { claim } = await fundedCompany.api.post<{ claim: Claim }>("/claims", newClaimBody());

    const decided = await fundedCompany.api.patch<{ claim: Claim }>(
      `/claims/${claim.id}/status`,
      { status: "APPROVED" }
    );
    expect(decided.claim.status).toBe("APPROVED");

    const { claims } = await fundedCompany.api.get<{ claims: Claim[] }>("/claims");
    expect(claims.find((c) => c.id === claim.id)?.status).toBe("APPROVED");
  });

  test("a MEMBER cannot approve, not even their own claim", async ({ memberApi, adminApi }) => {
    const { claim } = await memberApi.post<{ claim: Claim }>("/claims", newClaimBody({ amount: 1 }));

    const res = await memberApi.raw().patch(`/claims/${claim.id}/status`, { status: "APPROVED" });
    expect(res.status()).toBe(403);

    // Still pending, and tidied away through the admin.
    const { claims } = await adminApi.get<{ claims: Claim[] }>("/claims");
    expect(claims.find((c) => c.id === claim.id)?.status).toBe("PENDING");
    await adminApi.raw().delete(`/claims/${claim.id}`);
  });

  test("a status the schema doesn't know is refused", async ({ fundedCompany }) => {
    const { claim } = await fundedCompany.api.post<{ claim: Claim }>("/claims", newClaimBody());

    const res = await fundedCompany.api
      .raw()
      .patch(`/claims/${claim.id}/status`, { status: "MAYBE" });
    expect(res.status()).toBe(400);
  });
});

test.describe("Company boundary", () => {
  test("an outside company sees none of these claims", async ({ fundedCompany, outsiderApi }) => {
    const { claim } = await fundedCompany.api.post<{ claim: Claim }>("/claims", newClaimBody());

    const { claims } = await outsiderApi.get<{ claims: Claim[] }>("/claims");
    expect(claims.map((c) => c.id)).not.toContain(claim.id);
  });

  test("an outside admin cannot decide this company's claim", async ({
    fundedCompany,
    outsiderApi,
  }) => {
    const { claim } = await fundedCompany.api.post<{ claim: Claim }>("/claims", newClaimBody());

    // The admin's own claim starts APPROVED, so the outsider tries to flip it
    // to REJECTED — an attempt that would visibly change something if it got
    // through.
    expect(claim.status).toBe("APPROVED");
    const res = await outsiderApi.raw().patch(`/claims/${claim.id}/status`, { status: "REJECTED" });
    expect(res.status()).toBe(404);

    const { claims } = await fundedCompany.api.get<{ claims: Claim[] }>("/claims");
    expect(claims.find((c) => c.id === claim.id)?.status).toBe("APPROVED");
  });

  test("/claims refuses an anonymous caller", async ({ anonApi }) => {
    const list = await anonApi.raw().get("/claims");
    expect(list.status()).toBe(401);

    const decide = await anonApi.raw().patch(`/claims/${ABSENT_ID}/status`, { status: "APPROVED" });
    expect(decide.status()).toBe(401);
  });
});
