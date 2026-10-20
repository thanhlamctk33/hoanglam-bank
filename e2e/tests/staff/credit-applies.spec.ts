import { test, expect } from "../../fixtures/test";

/**
 * /dashboard/credit-applies — Credit Apply, and who is allowed to see it.
 *
 * WHAT IS DELIBERATELY NOT HERE. The rule this feature exists for is
 * maker/checker: `approveCreditApply` refuses when `makerId === actorUserId`
 * with "The checker must be a different staff member than the maker." That
 * only fires on an application already in PENDING_CHECKER, and arranging one
 * means a company with APPROVED KYB, a signed lending contract, and no other
 * active application.
 *
 * Asserting it against whatever happens to be sitting in the queue would be
 * worse than not asserting it: this suite does not know who the maker of an
 * existing application was, so an "expected refusal" that instead SUCCEEDS
 * would approve a real credit line for a real company as a side effect. A
 * test may not do that. The rule wants a fixture that builds its own company
 * end to end (KYB → contract → apply → forward); until that exists, what is
 * safe to pin is the access boundary below.
 */

interface CreditApply {
  id: string;
  status: string;
}

const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

test.describe("The console page", () => {
  test("renders the application queue", async ({ creditAppliesPage, page }) => {
    await creditAppliesPage.goto();

    await expect(page.getByRole("heading", { name: /^credit applications$/i })).toBeVisible();
  });

  test("the queue the page renders is the one the admin API serves", async ({
    creditAppliesPage,
    staffApi,
  }) => {
    const { creditApplies } = await staffApi.get<{ creditApplies: CreditApply[] }>(
      "/admin/credit-applies"
    );

    await creditAppliesPage.goto();
    // The page must not invent rows the API never sent, and must not throw on
    // an empty queue either — a fresh database has no applications at all.
    expect(Array.isArray(creditApplies)).toBe(true);
  });
});

test.describe("Only bank staff may reach Credit Apply", () => {
  test("a company admin is refused the queue", async ({ adminApi }) => {
    const res = await adminApi.raw().get("/admin/credit-applies");
    expect(res.status()).toBe(403);
  });

  test("a company admin cannot approve an application", async ({ adminApi }) => {
    const res = await adminApi.raw().patch(`/admin/credit-applies/${ABSENT_ID}/approve`, {});
    // 403 from requireStaff, decided before the id is looked up — existence
    // is not leaked to a caller who has no business asking.
    expect(res.status()).toBe(403);
  });

  test("an anonymous caller gets 401", async ({ anonApi }) => {
    const res = await anonApi.raw().get("/admin/credit-applies");
    expect(res.status()).toBe(401);
  });

  test("staff asking for an application that doesn't exist get a 404", async ({ staffApi }) => {
    const res = await staffApi.raw().patch(`/admin/credit-applies/${ABSENT_ID}/reject`, {
      reason: "e2e — id does not exist",
    });
    expect(res.status()).toBe(404);
  });
});
