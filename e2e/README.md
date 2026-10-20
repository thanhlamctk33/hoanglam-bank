# e2e — Playwright tests for hoanglam-bank

> Architecture overview as a standalone page: [`docs/playwright-overview.html`](docs/playwright-overview.html)
> (projects, fixtures, page objects, coverage map, CI, agents). Open it in a browser.

End-to-end coverage that exercises the real backend and the real frontend
together. Unit tests live next to the code they test (`vitest` in `backend/`
and `frontend/`); this folder is the layer above that: it only ever talks to
the app the way a user or an API consumer would.

```
e2e/
├── playwright.config.ts   projects, reporters, and the BE+FE webServer setup
├── fixtures/              the `test` object every spec imports
│   ├── test.ts            index: merges the three groups below
│   ├── roles.ts           WHO is calling  (adminApi, memberApi, …)
│   ├── sandbox.ts         WHERE the money lives (payer/payee pair)
│   ├── pages.ts           WHAT they are looking at (page objects)
│   └── session.ts         WHETHER the browser is signed in
├── pages/                 page objects (one per screen)
├── tests/
│   ├── auth.setup.ts      logs in once, saves the session to .auth/
│   ├── api/               HTTP-only contract tests (no browser)
│   ├── ui/                browser tests, starting already signed in
│   └── staff/             the Operator Console, under a staff session
├── reporters/             the classified failure report `npm run heal` writes
├── scripts/preflight.mjs  environment check that runs before a healing pass
└── utils/                 env config, API client, test-data generators
```

## Prerequisites

1. Postgres running, with `backend/.env` pointing at it.
2. Dependencies installed in `backend/` and `frontend/`.
3. **The database seeded** — the specs assume the demo users exist:

   ```bash
   cd ../backend && npm run seed
   ```

   | Account | Email | Password | Role |
   | --- | --- | --- | --- |
   | Company owner (main) | `demo@lambank.dev` | `password123` | ADMIN |
   | Teammate, same company | `member@lambank.dev` | `password123` | MEMBER |
   | Second customer | `hoa@lambank.dev` | `password123` | ADMIN |
   | Back-office operator (maker) | `admin@lambank.dev` | `staff123` | staff |
   | Back-office operator (checker) | `checker@lambank.dev` | `staff123` | staff |

   The MEMBER account is what makes the maker/checker specs possible: it has
   no approval power, so anything it creates lands in the approval queue.

4. `frontend/.env.local` must have `NEXT_PUBLIC_ENABLE_DEMO_TOOLS=true`, which
   is what makes the fixed demo OTP (`8888`) usable.

## Install

```bash
cd e2e
npm install
npm run install:browsers   # downloads Chromium
```

## Run

```bash
npm test              # everything: api + setup + chromium + staff
npm run test:api      # HTTP only — fastest, no browser needed
npm run test:ui       # browser specs only
npm run test:headed   # watch it happen
npm run test:debug    # step through with the Playwright inspector
npm run report        # open the last HTML report
```

Playwright starts `npm run dev` for both `backend/` and `frontend/` itself and
waits for `/api/health` and the Next.js server before the first test. If you
already have them running:

```bash
E2E_NO_SERVER=1 npm test
```

## Configuration

Everything is overridable through environment variables — see `utils/env.ts`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `E2E_WEB_URL` | `http://localhost:3000` | Frontend base URL |
| `E2E_API_URL` | `http://localhost:4000` | Backend origin (no `/api`) |
| `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` | demo owner | Main test account |
| `E2E_USER2_ACCOUNT` | `US-0002-7734` | Transfer recipient |
| `E2E_OTP` | `8888` | Demo confirmation code |
| `E2E_NO_SERVER` | unset | `1` skips the auto-started servers |

When Playwright starts the backend itself it also passes
`AUTH_RATE_LIMIT_MAX=1000` and `GENERAL_RATE_LIMIT_MAX=5000` (see
`playwright.config.ts`). The suite drives roughly ten *failed* logins per pass
by design — wrong password, unknown email, duplicate email, bad OTP — and the
production auth ceiling is exactly ten per IP per 15 minutes, so without this a
re-run inside that window (or a single CI retry) starts failing auth tests with
429s that have nothing to do with what they assert. Only the ceiling moves: the
limiter stays mounted, and `tests/api/rate-limit.api.spec.ts` asserts that it
does. **If you run the backend yourself with `E2E_NO_SERVER=1`, export those two
variables too**, or expect flakes on the second run.

## How the pieces fit

**Auth runs once.** The `setup` project signs in through the real login form
and writes the browser state to `.auth/user.json`; the `chromium` project
declares `dependencies: ["setup"]` and loads that state, so no UI spec pays
for a login. Specs that need to be signed out opt back out:

```ts
test.use({ storageState: LOGGED_OUT_STATE });
```

**Arrange over HTTP, assert through the UI.** Fixtures hand a spec an
authenticated `ApiClient`, so setup ("which account id do I have?") and
verification ("did the balance actually move?") go straight to the backend,
while the behaviour under test stays a real click path.

Each API fixture is named after *who* is making the call, because nearly every
interesting assertion in this app is about authorisation — reading
`memberApi.raw().get("/approvals")` tells you the point of the test without
scrolling up to find what `client` was logged in as:

| Fixture | Who | Scope |
| --- | --- | --- |
| `adminApi` | ADMIN of the seeded company | worker |
| `memberApi` | MEMBER of the same company — the *maker* in maker/checker | worker |
| `staffApi` | Bank back-office operator (`isStaff`), not a company admin | worker |
| `sandbox` | Two private companies — a funded `payer` and an empty `payee` | worker |
| `fundedCompany` | One funded company minted **per test** — every plan quota starts at zero | test |
| `outsiderApi` | A company registered fresh **for that one test** | test |
| `anonApi` | No token — for "this route must answer 401" | worker |
| `adminAuth` | The raw `/auth/login` response (token, user, company) | worker |

The standing roles are worker-scoped: one login per worker instead of one per
test. That keeps the suite fast, keeps load off the auth limiter, and is what
makes them usable from `test.beforeAll`, which Playwright only allows for
worker fixtures. `outsiderApi` is test-scoped on purpose — "a company that has
never seen this data" is only true if it is minted per test.

Page objects arrive the same way: `loginPage`, `operatorLoginPage`,
`registerPage`, `homePage`, `transferPage`, `accountsPage`, `transactionsPage`.
Every fixture is lazy, so a spec that never mentions `staffApi` never logs a
staff user in.

**One file per question.** `fixtures/test.ts` is only an index — it merges
three groups with `mergeTests` and re-exports them, so the reasoning for a
fixture sits next to the fixture rather than in one long preamble:

| File | Answers | Holds |
| --- | --- | --- |
| `fixtures/roles.ts` | who is calling | `adminApi`, `adminAuth`, `memberApi`, `staffApi`, `checkerApi`, `outsiderApi`, `anonApi` |
| `fixtures/sandbox.ts` | where the money lives | `sandbox` |
| `fixtures/pages.ts` | what they are looking at | the seven page objects |
| `fixtures/session.ts` | whether the browser is signed in | `LOGGED_OUT_STATE`, `clearSession()` |

Nothing about the import changed: specs still do `import { test, expect } from
"../../fixtures/test"`, and every fixture keeps its name.

**A failed sign-in says what to fix.** Setup fails for two boring reasons far
more often than an interesting one — the backend is down, or the database was
never seeded — so every sign-in goes through `withSetupHint()` and reports
those two checks (plus the original error) instead of a bare
`POST /auth/login → 401`.

**Selectors are roles and labels, not CSS.** The app has no `data-testid`
attributes, so page objects locate things the way a screen reader would
(`getByRole`, `getByLabel`, `getByPlaceholder`). A locator that breaks usually
means an accessibility regression, not just a renamed class.

## Writing a new spec

```ts
import { test, expect } from "../../fixtures/test";

test("does the thing", async ({ transferPage, adminApi }) => {
  const source = await adminApi.firstAccount("USD");  // arrange over HTTP
  await transferPage.goto();                          // act through the UI
  // ...
});
```

Import `test` from `fixtures/test`, never from `@playwright/test` directly —
that's what wires up the page objects and the API clients. No spec in this
suite logs anyone in by hand; if you find yourself writing `beforeAll(... login
...)`, the fixture you want is probably already there.

## Playwright Agents (test healing)

`npx playwright init-agents --loop=claude` has already been run here, so three
agent definitions live in `.claude/agents/`:

| Agent | What it does |
| --- | --- |
| `playwright-test-planner` | Explores the app and writes a test plan into `specs/` |
| `playwright-test-generator` | Turns a plan into real spec files |
| `playwright-test-healer` | Runs the suite, debugs failures, and edits the code until green |

Start Claude Code **from this `e2e/` folder** (the `.mcp.json` here points at
the `playwright-test` MCP server, and the agents resolve
`playwright.config.ts` relative to the working directory), then:

```
> Fix the failing tests          # invokes the healer
```

The healer debugs a failing test, snapshots the live DOM, regenerates the
locator, edits the spec, and re-runs until it passes.

**This is healing at authoring time, not at runtime.** It produces a git diff
you must review. The stock agent is allowed to silence a stubborn test with
`test.fixme()`, which would hide a real bug — so `.claude/agents/playwright-test-healer.md`
has a project-specific section appended forbidding that on financial
assertions, and telling it to check for an unseeded database first. Keep those
rules if you regenerate the agents; `init-agents` overwrites the file.

The generator agent expects an empty `tests/ui/seed.spec.ts` as its starting
browser context. That file was moved to `_to_delete/` and is no longer in the
run — recreate it (an empty `test("seed", async () => {})`) before using the
generator, or point the agent at an existing spec instead.

## Plan quotas decide which fixture a spec needs

A newly registered company lands on the FREE plan, and FREE counts: **3 active
cards, 2 active budgets, 5 expense claims per month**
(`backend/src/features/platform/subscription/plans.config.ts`). Anything that
*creates* one of those cannot share a company with the rest of the suite — it
would start failing with `402 Payment Required` in whatever order the tests
happened to run.

| The spec... | Use |
| --- | --- |
| reads the seeded company's own data | `adminApi` |
| does arithmetic on a balance | `sandbox` |
| creates cards / budgets / claims | `fundedCompany` |
| needs a caller with no history at all | `outsiderApi` |

The UI specs are the exception: they share the demo user's browser session, so
`tests/ui/spend.spec.ts` creates its object over HTTP, asserts it on screen,
and deletes it again in a `finally`. Keep that cleanup — it is what stops the
demo company drifting into its own plan cap over time.

## Healing a red suite

```bash
npm run heal        # preflight, then the whole suite with the failure report
npm run heal:api    # narrow to the API project
npm run heal:ui     # narrow to the browser project
```

`npm run heal` differs from `playwright test` in two ways:

1. **It checks the environment first.** `scripts/preflight.mjs` confirms the
   backend answers and that all four seeded logins still work, and says
   plainly when it verified nothing because the servers are not up yet. Most
   "the whole suite is red" mornings end here, with `npm run seed`, and no
   spec should be edited before this passes.
2. **It classifies every failure.** `reporters/failure-report.reporter.ts`
   writes `heal/FAILURES.md` and `heal/failures.json`, tagging each failure
   `SETUP`, `LOCATOR`, `TIMEOUT`, `HTTP_STATUS`, `PLAN_LIMIT`, `MONEY` or
   `ASSERTION` and printing the rule that applies to it — because the kind is
   what decides whether the legitimate fix is a page-object edit, a different
   fixture, a re-seed, or a bug report against the backend. A `MONEY` failure
   is never fixed by relaxing the number.

`heal/` is gitignored and regenerated on every run. The healer agent in
`.claude/agents/` is pointed at this report rather than at terminal output.

## Notes and gotchas

- **Money specs run in their own world.** Anything asserting on a balance uses
  the `sandbox` fixture — two freshly registered companies (a funded payer and
  an empty payee) created once per worker. Nothing else in the suite can see
  them, so `before - amount` is exact rather than a race against another
  worker. Reach for `adminApi` only when the spec is genuinely about the
  seeded company's own history.
- **The UI specs still share the demo user**, because the browser session
  comes from `.auth/user.json`. They therefore assert on ledger rows carrying a
  unique note ("a DEBIT of exactly this amount, with this note") instead of on
  absolute balances — stronger *and* concurrency-proof.
- `fullyParallel` is off to keep output readable and to keep the shared
  spend-policy mutation in `approvals.api.spec.ts` tidy — no longer for
  balance-safety reasons.
- Each run leaves a handful of throwaway companies in the database (sandbox
  pairs plus the registration specs). Harmless, but re-seed occasionally if a
  local DB gets noisy.
- Projects: `api`, `setup`, `chromium` and `staff` run by default; `webkit`
  re-runs the same UI specs on Safari and is opt-in
  (`npx playwright test --project=webkit`). There is no Firefox project despite
  what the config comment says.
- Traces, screenshots and video are captured on failure only; open them with
  `npm run report`.
