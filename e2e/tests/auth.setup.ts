import { test as setup, expect } from "@playwright/test";
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
 */

function ensureAuthDir(file: string) {
  fs.mkdirSync(path.dirname(path.resolve(__dirname, "..", file)), { recursive: true });
}

setup("authenticate as company customer", async ({ page }) => {
  ensureAuthDir(STORAGE_STATE_PATH);

  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /log in to your account/i })).toBeVisible();

  // The demo build pre-fills these; fill() is idempotent and keeps the spec
  // honest if that convenience is ever removed.
  await page.getByLabel("Email").fill(DEMO_USER.email);
  await page.getByLabel("Password", { exact: false }).fill(DEMO_USER.password);
  await page.getByRole("button", { name: /^log in$/i }).click();

  // A customer lands on "/" — the authenticated app shell behind RequireAuth.
  await page.waitForURL((url) => new URL(url).pathname === "/", { timeout: 30_000 });
  await expect(page.getByRole("link", { name: /transfer money/i }).first()).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE_PATH });
});

setup("authenticate as back-office staff", async ({ page }) => {
  ensureAuthDir(STAFF_STORAGE_STATE_PATH);

  await page.goto("/dashboard/login");
  await expect(page.getByRole("heading", { name: /operator console/i })).toBeVisible();

  // The operator gate labels its field "Staff email", not "Email".
  await page.getByLabel(/staff email/i).fill(STAFF_USER.email);
  await page.getByLabel("Password", { exact: false }).fill(STAFF_USER.password);
  await page.getByRole("button", { name: /log in/i }).click();

  await page.waitForURL(/\/dashboard(?!\/login)/, { timeout: 30_000 });

  await page.context().storageState({ path: STAFF_STORAGE_STATE_PATH });
});
