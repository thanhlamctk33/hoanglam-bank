import { test as setup, expect } from "../fixtures/test";
import fs from "node:fs";
import path from "node:path";
import {
  DEMO_USER,
  STAFF_STORAGE_STATE_PATH,
  STAFF_USER,
  STORAGE_STATE_PATH,
} from "../utils/env";

/**
 * Runs once before the UI projects (wired up via `dependencies: ["setup"]`).
 *
 * It signs in through the real login form rather than injecting a token, so a
 * regression in the login flow fails here loudly instead of silently letting
 * every other spec run against a hand-made session. The resulting
 * localStorage + cookies are written to .auth/*.json and reused by every UI
 * test, which saves a login round-trip per spec file.
 *
 * Both hooks drive the same page objects the specs use — if a locator here
 * needs changing, the fix lands in pages/login.page.ts and every spec that
 * touches the gate inherits it.
 */

function ensureAuthDir(file: string) {
  fs.mkdirSync(path.dirname(path.resolve(__dirname, "..", file)), { recursive: true });
}

setup("authenticate as company customer", async ({ page, loginPage }) => {
  ensureAuthDir(STORAGE_STATE_PATH);

  await loginPage.goto();
  // The demo build pre-fills these; fill() is idempotent and keeps the setup
  // honest if that convenience is ever removed.
  await loginPage.login(DEMO_USER.email, DEMO_USER.password);

  // A customer lands on "/" — the authenticated app shell behind RequireAuth.
  await page.waitForURL((url) => new URL(url).pathname === "/", { timeout: 30_000 });
  await expect(page.getByRole("link", { name: /transfer money/i }).first()).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE_PATH });
});

setup("authenticate as back-office staff", async ({ page, operatorLoginPage }) => {
  ensureAuthDir(STAFF_STORAGE_STATE_PATH);

  // The operator gate labels its field "Staff email", not "Email" — that
  // difference lives in OperatorLoginPage, not here.
  await operatorLoginPage.goto();
  await operatorLoginPage.login(STAFF_USER.email, STAFF_USER.password);

  await page.waitForURL(/\/dashboard(?!\/login)/, { timeout: 30_000 });

  await page.context().storageState({ path: STAFF_STORAGE_STATE_PATH });
});
