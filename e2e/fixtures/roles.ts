import { test as base } from "@playwright/test";
import { ApiClient, AuthResponse } from "../utils/api-client";
import {
  API_BASE_URL,
  CHECKER_USER,
  DEMO_USER,
  MEMBER_USER,
  STAFF_USER,
} from "../utils/env";

/**
 * WHO IS CALLING.
 *
 * Almost every interesting assertion in this app is about authorisation, so
 * each fixture here is named after the identity making the request rather
 * than after what it returns. `memberApi.raw().get("/approvals")` states the
 * point of the test on its own line; `client.get(...)` would send you
 * scrolling upwards to find out who `client` was.
 *
 *   adminApi     ADMIN of the seeded company — the default "this should work"
 *   adminAuth    the raw /auth/login response, for ids rather than a client
 *   memberApi    MEMBER of the SAME company — the maker in maker/checker
 *   staffApi     bank back-office operator (isStaff), not a company admin
 *   checkerApi   a SECOND operator — proves a maker may not approve themselves
 *   outsiderApi  a company registered fresh for this one test
 *   anonApi      no token at all — for "this route must answer 401"
 *
 * SCOPE. The standing roles are worker-scoped: one sign-in per worker instead
 * of one per test. That keeps the suite fast, keeps load off the auth rate
 * limiter, and is what makes them usable from `test.beforeAll`, which
 * Playwright only allows for worker fixtures.
 *
 * `outsiderApi` is test-scoped on purpose: "a company that has never seen
 * this data" is only true if it is minted per test.
 *
 * Every fixture is lazy — a spec that never mentions `staffApi` never signs a
 * staff user in.
 */

/** Rebuilt for every `test(...)`. */
export interface RoleTestFixtures {
  outsiderApi: ApiClient;
}

/** Built once per worker and shared by every test that worker runs. */
export interface RoleWorkerFixtures {
  adminSession: { client: ApiClient; auth: AuthResponse };
  adminApi: ApiClient;
  adminAuth: AuthResponse;
  memberApi: ApiClient;
  staffApi: ApiClient;
  checkerApi: ApiClient;
  anonApi: ApiClient;
}

/**
 * Fixture setup fails for two boring reasons far more often than for an
 * interesting one: the backend isn't up, or the database was never seeded.
 * A raw `POST /auth/login → 401` in the middle of a red suite doesn't say
 * that, so every sign-in here goes through this and says it instead.
 */
export async function withSetupHint<T>(fixture: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      [
        `Could not build the "${fixture}" fixture.`,
        ``,
        `Check, in order:`,
        `  1. Is the backend answering at ${API_BASE_URL} ?`,
        `  2. Has the database been seeded?   cd ../backend && npm run seed`,
        `  3. Do the credentials in utils/env.ts still match the seed?`,
        ``,
        `Original error: ${detail}`,
      ].join("\n")
    );
  }
}

/** Builds a worker-scoped fixture that signs `credentials` in and cleans up. */
function signedInAs(fixture: string, credentials: { email: string; password: string }) {
  return async ({}, use: (client: ApiClient) => Promise<void>) => {
    const { client } = await withSetupHint(fixture, () => ApiClient.login(credentials));
    await use(client);
    await client.dispose();
  };
}

export const rolesTest = base.extend<RoleTestFixtures, RoleWorkerFixtures>({
  // adminApi and adminAuth come out of ONE sign-in, not two.
  adminSession: [
    async ({}, use) => {
      const session = await withSetupHint("adminSession", () => ApiClient.login(DEMO_USER));
      await use(session);
      await session.client.dispose();
    },
    { scope: "worker" },
  ],

  adminApi: [async ({ adminSession }, use) => use(adminSession.client), { scope: "worker" }],
  adminAuth: [async ({ adminSession }, use) => use(adminSession.auth), { scope: "worker" }],

  memberApi: [signedInAs("memberApi", MEMBER_USER), { scope: "worker" }],
  staffApi: [signedInAs("staffApi", STAFF_USER), { scope: "worker" }],
  checkerApi: [signedInAs("checkerApi", CHECKER_USER), { scope: "worker" }],

  anonApi: [
    async ({}, use) => {
      const client = await ApiClient.anonymous();
      await use(client);
      await client.dispose();
    },
    { scope: "worker" },
  ],

  outsiderApi: async ({}, use) => {
    const { client } = await withSetupHint("outsiderApi", () => ApiClient.registerNewCompany());
    await use(client);
    await client.dispose();
  },
});
