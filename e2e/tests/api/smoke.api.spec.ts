import { test, expect } from "@playwright/test";
import { ApiClient } from "../../utils/api-client";
import { API_BASE_URL, DEMO_USER } from "../../utils/env";

/**
 * Breadth-first coverage: every read-only endpoint the app calls on page load
 * must answer 200 for a signed-in caller and 401 for an anonymous one.
 *
 * This is the cheapest way to catch a route that was renamed, unmounted, or
 * accidentally left without `requireAuth` — the kind of regression a
 * feature-focused spec never touches.
 */

const READ_ENDPOINTS = [
  "/accounts",
  "/payees",
  "/transfers/recurring",
  "/transfers/recent-recipients",
  "/cards",
  "/budgets",
  "/claims",
  "/bills",
  "/categories",
  "/credit",
  "/kyb",
  "/team",
  "/subscription",
  "/notifications",
  "/alerts",
];

let client: ApiClient;

test.beforeAll(async () => {
  ({ client } = await ApiClient.login(DEMO_USER));
});

test.afterAll(async () => {
  await client.dispose();
});

test.describe("Authenticated reads", () => {
  for (const path of READ_ENDPOINTS) {
    test(`GET ${path} answers 200`, async () => {
      const res = await client.raw().get(path);
      expect(
        res.status(),
        `GET ${path} returned ${res.status()}: ${await res.text()}`
      ).toBe(200);
    });
  }
});

test.describe("Anonymous reads", () => {
  for (const path of READ_ENDPOINTS) {
    test(`GET ${path} answers 401`, async ({ request }) => {
      const res = await request.get(`${API_BASE_URL}${path}`);
      expect(res.status(), `GET ${path} is missing requireAuth`).toBe(401);
    });
  }
});

test.describe("Unknown routes", () => {
  test("404 with a JSON body, not an HTML error page", async ({ request }) => {
    const res = await request.get(`${API_BASE_URL}/definitely-not-a-route`);

    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

test.describe("Security headers", () => {
  test("helmet is applied to API responses", async ({ request }) => {
    const res = await request.get(`${API_BASE_URL}/health`);
    const headers = res.headers();

    expect(headers["x-content-type-options"]).toBe("nosniff");
    // helmet hides the framework banner.
    expect(headers["x-powered-by"]).toBeUndefined();
  });
});
