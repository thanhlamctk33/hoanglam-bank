import { test as base, expect, Page } from "@playwright/test";
import { ApiClient, AuthResponse } from "../utils/api-client";
import { DEMO_USER, TOKEN_STORAGE_KEY } from "../utils/env";
import { LoginPage } from "../pages/login.page";
import { HomePage } from "../pages/home.page";
import { TransferPage } from "../pages/transfer.page";
import { AccountsPage } from "../pages/accounts.page";

/**
 * The project-wide `test` object. Import this instead of `@playwright/test`
 * in every spec — it adds:
 *
 *   api        an authenticated ApiClient sharing the UI session's user, for
 *              arranging state ("give me an account id") without clicking
 *   auth       the raw /auth/login response (token, user, company)
 *   loginPage  … and the other page objects, already bound to `page`
 *
 * Fixtures are lazy: a spec that never touches `api` never logs in over HTTP.
 */

interface Fixtures {
  api: ApiClient;
  auth: AuthResponse;
  loginPage: LoginPage;
  homePage: HomePage;
  transferPage: TransferPage;
  accountsPage: AccountsPage;
}

export const test = base.extend<Fixtures>({
  auth: async ({}, use) => {
    const { client, auth } = await ApiClient.login(DEMO_USER);
    await use(auth);
    await client.dispose();
  },

  api: async ({}, use) => {
    const { client } = await ApiClient.login(DEMO_USER);
    await use(client);
    await client.dispose();
  },

  loginPage: async ({ page }, use) => use(new LoginPage(page)),
  homePage: async ({ page }, use) => use(new HomePage(page)),
  transferPage: async ({ page }, use) => use(new TransferPage(page)),
  accountsPage: async ({ page }, use) => use(new AccountsPage(page)),
});

export { expect };

/** Storage state representing "nobody is signed in". */
export const LOGGED_OUT_STATE = { cookies: [], origins: [] };

/**
 * Drops the JWT the app keeps in localStorage. Useful mid-spec when a test
 * needs to prove the app bounces an expired session back to /login.
 */
export async function clearSession(page: Page) {
  await page.evaluate((key) => window.localStorage.removeItem(key), TOKEN_STORAGE_KEY);
}
