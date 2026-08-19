import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import {
  API_ORIGIN,
  REUSE_RUNNING_SERVERS,
  STAFF_STORAGE_STATE_PATH,
  STORAGE_STATE_PATH,
  WEB_BASE_URL,
} from "./utils/env";

const repoRoot = path.resolve(__dirname, "..");
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests",
  // Money-movement specs mutate shared seeded balances, so a spec never runs
  // in parallel with itself; independent files still run concurrently.
  fullyParallel: false,
  workers: isCI ? 1 : 2,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: isCI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["html", { open: "never" }], ["list"]],

  use: {
    baseURL: WEB_BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Deterministic viewport keeps the responsive sidebar expanded.
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    // 1. Pure HTTP tests. No browser, no auth setup — they mint their own
    //    tokens, so they stay usable even when the UI is broken.
    {
      name: "api",
      testDir: "./tests/api",
      use: { baseURL: API_ORIGIN },
    },

    // 2. Logs in once through the real UI and writes the browser state
    //    (localStorage JWT + cookies) to disk for every UI project below.
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
    },

    // 3. UI specs, starting already authenticated.
    {
      name: "chromium",
      testDir: "./tests/ui",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: STORAGE_STATE_PATH,
      },
      // Specs that must start signed out opt out via test.use({ storageState:
      // { cookies: [], origins: [] } }) — see tests/ui/auth.spec.ts.
    },

    // 4. Same specs on WebKit/Firefox — off by default, enable with
    //    `npx playwright test --project=webkit`.
    {
      name: "webkit",
      testDir: "./tests/ui",
      dependencies: ["setup"],
      use: { ...devices["Desktop Safari"], storageState: STORAGE_STATE_PATH },
    },
  ],

  // Playwright boots both servers and waits for each to answer before the
  // first test runs. Set E2E_NO_SERVER=1 to skip when they're already up.
  webServer: REUSE_RUNNING_SERVERS
    ? undefined
    : [
        {
          command: "npm run dev",
          cwd: path.join(repoRoot, "backend"),
          url: `${API_ORIGIN}/api/health`,
          reuseExistingServer: !isCI,
          timeout: 120_000,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: "npm run dev",
          cwd: path.join(repoRoot, "frontend"),
          url: WEB_BASE_URL,
          reuseExistingServer: !isCI,
          timeout: 180_000,
          stdout: "pipe",
          stderr: "pipe",
        },
      ],

  outputDir: "./test-results",
});

// Re-exported so specs that need the staff session can reference the path
// without importing utils/env directly.
export { STAFF_STORAGE_STATE_PATH };
