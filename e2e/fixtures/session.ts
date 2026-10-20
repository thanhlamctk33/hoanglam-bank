import { Page } from "@playwright/test";
import { TOKEN_STORAGE_KEY } from "../utils/env";

/**
 * WHETHER THE BROWSER IS SIGNED IN.
 *
 * The UI projects start from the storageState written by tests/auth.setup.ts,
 * so a spec is signed in as the demo company unless it says otherwise. These
 * two helpers are how it says otherwise.
 */

/**
 * Storage state meaning "nobody is signed in". Opt a whole file out of the
 * shared session with:
 *
 *   test.use({ storageState: LOGGED_OUT_STATE });
 */
export const LOGGED_OUT_STATE = { cookies: [], origins: [] };

/**
 * Drops the JWT the app keeps in localStorage, mid-spec — for proving that
 * RequireAuth bounces a dead session back to /login rather than rendering an
 * empty shell.
 */
export async function clearSession(page: Page) {
  await page.evaluate((key) => window.localStorage.removeItem(key), TOKEN_STORAGE_KEY);
}
