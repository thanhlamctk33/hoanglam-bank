# e2e — Playwright tests for hoanglam-bank

End-to-end coverage that exercises the real backend and the real frontend
together. Unit tests live next to the code they test (`vitest` in `backend/`
and `frontend/`); this folder is the layer above that: it only ever talks to
the app the way a user or an API consumer would.

```
e2e/
├── playwright.config.ts   projects, reporters, and the BE+FE webServer setup
├── fixtures/test.ts       the `test` object every spec imports
├── pages/                 page objects (one per screen)
├── tests/
│   ├── auth.setup.ts      logs in once, saves the session to .auth/
│   ├── api/               HTTP-only contract tests (no browser)
│   └── ui/                browser tests, starting already signed in
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
   | Back-office operator | `admin@lambank.dev` | `password123` | staff |

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
npm test              # everything: api + setup + chromium
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

## How the pieces fit

**Auth runs once.** The `setup` project signs in through the real login form
and writes the browser state to `.auth/user.json`; the `chromium` project
declares `dependencies: ["setup"]` and loads that state, so no UI spec pays
for a login. Specs that need to be signed out opt back out:

```ts
test.use({ storageState: LOGGED_OUT_STATE });
```

**Arrange over HTTP, assert through the UI.** The `api` fixture hands a spec an
authenticated `ApiClient` sharing the same user, so setup ("which account id do
I have?") and verification ("did the balance actually move?") go straight to
the backend, while the behaviour under test stays a real click path.

**Selectors are roles and labels, not CSS.** The app has no `data-testid`
attributes, so page objects locate things the way a screen reader would
(`getByRole`, `getByLabel`, `getByPlaceholder`). A locator that breaks usually
means an accessibility regression, not just a renamed class.

## Writing a new spec

```ts
import { test, expect } from "../../fixtures/test";

test("does the thing", async ({ transferPage, api }) => {
  const source = await api.firstAccount("USD");   // arrange over HTTP
  await transferPage.goto();                       // act through the UI
  // ...
});
```

Import `test` from `fixtures/test`, never from `@playwright/test` directly —
that's what wires up the page objects and the API client.

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

`tests/ui/seed.spec.ts` is an empty test the generator agent uses as its
starting browser context. Leave it there — it costs one no-op test.

## Notes and gotchas

- **Specs mutate seeded data.** Transfers really move money. Amounts are kept
  small and randomised, but re-seed if balances drift somewhere odd.
- `fullyParallel` is off, because several specs read the same account balance.
- Firefox/WebKit projects are defined but not in the default run:
  `npx playwright test --project=webkit`.
- Traces, screenshots and video are captured on failure only; open them with
  `npm run report`.
