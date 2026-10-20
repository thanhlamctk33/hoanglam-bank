import { mergeTests, expect } from "@playwright/test";
import { rolesTest, RoleTestFixtures, RoleWorkerFixtures } from "./roles";
import { sandboxTest, SandboxTestFixtures, SandboxWorkerFixtures } from "./sandbox";
import { pagesTest, PageFixtures } from "./pages";

/**
 * The project-wide `test` object. EVERY spec — UI and API alike — imports
 * `test`/`expect` from here rather than from "@playwright/test"; that is what
 * wires up the page objects and the API clients, and it is why no spec in
 * this suite ever hand-rolls a login in `beforeAll`.
 *
 *     import { test, expect } from "../../fixtures/test";
 *
 *     test("does the thing", async ({ transferPage, adminApi }) => {
 *       const source = await adminApi.firstAccount("USD");  // arrange over HTTP
 *       await transferPage.goto();                          // act through the UI
 *     });
 *
 * The fixtures themselves live in three files, each answering one question.
 * Open the file, not this index, for the reasoning behind a fixture.
 *
 *   ./roles.ts     WHO is calling
 *                  adminApi · adminAuth · memberApi · staffApi · checkerApi
 *                  outsiderApi · anonApi
 *
 *   ./sandbox.ts   WHERE the money lives
 *                  sandbox (a private payer/payee pair, for balance maths)
 *                  fundedCompany (a funded company per test, for anything
 *                  that CREATES cards/budgets/claims under a plan quota)
 *
 *   ./pages.ts     WHAT they are looking at
 *                  loginPage · operatorLoginPage · registerPage · homePage
 *                  transferPage · accountsPage · transactionsPage
 *
 *   ./session.ts   WHETHER the browser is signed in
 *                  LOGGED_OUT_STATE · clearSession()
 *
 * If you find yourself writing `beforeAll(... login ...)`, the fixture you
 * want almost certainly already exists in one of those.
 */
export const test = mergeTests(rolesTest, sandboxTest, pagesTest);

export { expect };
export { LOGGED_OUT_STATE, clearSession } from "./session";
export type { Sandbox, SandboxCompany, FundedCompany } from "./sandbox";

/** Kept as the historical names for the two fixture groups by scope. */
export type TestFixtures = RoleTestFixtures & SandboxTestFixtures & PageFixtures;
export type WorkerFixtures = RoleWorkerFixtures & SandboxWorkerFixtures;
