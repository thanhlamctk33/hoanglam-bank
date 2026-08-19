# LamBank — business banking dashboard

A business banking dashboard (in the style of app.aspireapp.com), with a Node.js/Express API and a Next.js frontend.

## Stack

- **Backend**: Node.js, Express, TypeScript, Prisma ORM, PostgreSQL, JWT auth
- **Frontend**: Next.js (App Router), React, Tailwind CSS

## Scope (MVP)

- Auth: register / login / JWT session
- **Accounts**: Cash balances (per-account hero card, copy account number, CSV statement, frozen-account banner, "Add funds" for a sandbox wire-in deposit, "Open new account" to add a 2nd+ account in any supported currency — both Admin/staff only), Transactions (paginated with Load more, filter by type/category/date range, grouped by day, summary totals, row detail modal, CSV export), Reports (`/accounts/reports` — monthly cash-flow in/out trend chart and spend-by-category breakdown, filterable by account and 3/6/12-month period; `GET /api/accounts/reports` aggregates on the fly from existing Transaction rows, no new tables)
- **New company signup**: `POST /api/auth/register` now creates a default USD "Cash Account" for the company immediately (via `getOrCreatePrimaryAccount`), so a brand-new signup isn't a dead end — Transfer/Cards/Budgets/Bills all have an account to work with right away. To actually fund it (no real bank rail exists in this sandbox), use "Add funds" on the Cash page (`POST /api/accounts/:id/deposit`, Admin/staff only, capped at $1,000,000/request) — it simulates an incoming wire: credits the balance and writes a normal CREDIT transaction, same as any other money movement.
- **Spend**: Cards (freeze/unfreeze), Budgets (freeze/unfreeze, edit limit), Claims (OCR auto-fill from JPG/PNG/GIF **and PDF** receipts via Claude vision — requires `ANTHROPIC_API_KEY` set in `backend/.env`, see note below; bulk upload up to 20 receipts with no manual review step for anything that scans cleanly, click-to-preview, currency picker, submit/approve/reject/delete), Bills (create/delete, and "Pay bill" is a real payment — pick an account, it debits the balance and writes a Transaction, same as every other money-movement flow; distinct from Payments → Bill Payment, which pays *utility* providers by customer code)
- **Team & approvals**: each company can have multiple users with role Admin or Member. Members create cards/budgets/claims as requests; Admins act instantly and approve/reject Member requests right on the same page (bell icon on Cards/Budgets, inline on Claims) — no bank staff involvement needed. Manage members at `/settings/team`. Bank staff (`isStaff`) still has full cross-company oversight at `/dashboard` (reachable via "Admin console" in the top bar after logging in through the normal `/login`).
- **Subscription**: Free / Pro / Business company plans that cap active cards, active budgets, and monthly expense claims, and give a discount on utility bill payments. Self-service upgrade/downgrade at `/settings/subscription`.
- **Mandatory onboarding (KYC → KYB)**: right after registering, an ADMIN is walked through `/onboarding` — a 5-step wizard (Identity → Business profile → Beneficial owners → Documents → Review & submit) — before `RequireAuth` lets them into the main dashboard. Step 1 is **KYC** (`KycProfile` table, `/api/kyc`): the registering individual's own identity (name, DOB, nationality, ID number + a photo of their ID). Steps 2-4 are the existing **KYB** business-verification fields (below). Both auto-approve the moment they're submitted — this is a sandbox with no real document-verification vendor or underwriting team, and gating dashboard access on a human bank-staff review (KYB's queue is 100% manual, see below) would strand every new signup in "pending" indefinitely. Bank staff (`isStaff`) and invited MEMBER users always bypass onboarding (only the ADMIN who registers does personal KYC; MEMBER access rides on the company's own KYB status). The seeded "Nguyen Minh Trading" login (`hoa@lambank.dev`) is deliberately left un-verified so it doubles as a live demo of this wizard.
- **KYB (business verification)**: companies submit a business profile, beneficial owners, and supporting documents. Historically this queued for bank staff to review at `/dashboard/kyb` (still fully functional — Approve/Reject/Needs info, with audit logging), but as of the onboarding wizard above, submitting now auto-approves immediately instead of entering that queue. Until approved, physical card issuance is blocked and transfers/payments over $1,000 are capped. Company-facing flow is at `/settings/verification` (still useful post-onboarding to view status/documents).
- **Lending (Credit Apply → Drawdown → Repayment)**: once KYB is approved, an account admin signs the lending contract at `/credit`. Bank staff then submit a Credit Apply for the business from `/dashboard/credit-applies` (maker); a *different* staff member must approve or reject it (checker) — self-approval is blocked. Once approved, the company sees its credit limit at `/credit` and can draw funds down (after confirming the lending terms) straight into its cash account, and make repayments against the outstanding balance; both recalculate the credit line's available amount immediately. Budgets can't be funded above the company's actual cash balance, and a card's spend limit can't exceed the budget it's assigned to.
- **Transfer**: one page for Internal transfer (recipient account number, or upload a photo of their QR code — decoded client-side) and FX transfer (external recipient, mock currency conversion). Both go through a Review step and an OTP step (demo code `8888`) before the money moves. Amount entry validates against the account's available balance, formats with thousand separators, and has 25%/50%/Max quick-fill buttons. Recent recipients (derived from transaction history, no extra table) show as one-tap chips, alongside **Saved payees** — nicknamed recipients saved *before* a first transfer (`SavedPayee` table, `/api/payees`), which Recent recipients can't do since it only exists after the fact. FX transfers display an estimated 0.5% fee/spread alongside the mock converted amount (`backend/src/config/fx.ts` → `FX_FEE_PCT`, display-only, not deducted).
- **Recurring transfers** (`/transfer/recurring`): schedule an internal transfer to repeat weekly or monthly (`RecurringTransfer` table). There's no background worker in this sandbox, so due transfers run lazily — whenever `GET /api/transfers/recurring` is called (i.e. whenever someone opens that page), each active schedule that's due runs once and rolls its `nextRunAt` forward; it deliberately does **not** catch up and fire every missed occurrence in a burst if the page hasn't been opened in a while.
- **Bill autopay**: on Spend → Bills, a bill can be set to pay itself from a chosen account once due (`Bill.autopayAccountId`), via the same lazy-on-page-load pattern as recurring transfers — checked whenever `GET /api/bills` runs. Reuses the exact same debit/Transaction logic as the manual "Pay bill" button.
- **Advanced card controls**: each card has `allowOnline` / `allowAtm` toggles and a blocked-merchant-category list (`PATCH /api/cards/:id/controls`, Admin/staff only). Since this app has no real card network — nothing else ever moved money against a card's spend limit before this — there's also a **"Simulate a purchase"** action (`POST /api/cards/:id/simulate-purchase`) on the card detail view so these controls are real, testable rules rather than settings that do nothing; it checks channel/category/spend-limit and, if approved, increments the card's (and its budget's) `spent` counter. It does not touch any Account balance — cards were never linked to a specific settlement account in this schema, spend limits are tracked independently.
- **Categories** (`/settings/categories`): before this, merchant-category lists were hardcoded independently in the Cards page and the Bills page, with no shared source of truth. Each company now manages its own list at Settings → Categories (`MerchantCategory` table, `/api/categories`, add/delete, Admin/staff only to write, any member can read). The only current consumer is Card controls (blocked-category picker and the "Simulate a purchase" merchant-category dropdown) — both fetch from this list instead of a hardcoded array, and show a hint linking to Settings → Categories if the company hasn't added any yet. Deleting a category does **not** retroactively clean it out of any card's `blockedCategories` (a loose JSON string array, not a real foreign key — consistent with how that field was already designed).
- **Receive via QR** (`/payments/qr`): receive-only, renders a real scannable QR image (downloadable, and shareable via the Web Share API on supported devices/browsers). You can pick which account to receive into (if you have more than one) and optionally request a specific amount + note — the QR payload embeds it (`HLBQR:<accountNumber>|<amount>|<note>`), and scanning it on the Transfer page pre-fills the amount and note automatically. A plain "pay me" code (no requested amount) still just encodes the account number.
- **Team**: a company can have at most 4 Admins (the original director + up to 3 more); add/remove members and promote/demote at `/settings/team`.
- **KYB gating**: Transfer (and Credit/Drawdown) are disabled with a link to Business verification until KYB is approved.
- **Account menu**: the avatar in the top-right corner is now a dropdown — name/email, company + role, quick links to Team/Subscription/Business verification (and Admin console for staff), and Log out. Replaces the separate always-visible "Log out" (and, for staff, "Admin console") buttons that used to sit in the top bar.
- **Notifications**: a bell icon in the top bar (next to search) aggregates alerts that used to be scattered across separate pages — bills due within 7 days or overdue, frozen budgets, pending Card/Budget approval requests and expense claims (Admins/staff only), and an approved-but-unsigned credit line. Nothing is persisted in a new table; `GET /api/notifications` computes the list fresh from existing data each time the panel opens. Business-verification reminders stay on the existing top-of-page `KybBanner` rather than being duplicated here.
- **Assistant**: the in-app chatbot's knowledge lives in `backend/src/knowledge/app-guide.md` — it's read fresh on every request and used as the system prompt, so updating that file updates what the assistant knows without touching code.
- **Activity log** (`/settings/activity`, Admin/staff only): a company-scoped view over the same `AuditLog` table the bank staff Dashboard already used — filtered by `actorEmail` belonging to the company's own users (email is globally unique, so no `companyId` column needed on `AuditLog`, no new table). Covers card/budget create+edit+freeze, claim submit/approve/reject/delete, bill payment, internal + FX transfers, drawdown/repayment, contract signing, and subscription changes — several of these (internal transfer, claims, bill payment) didn't write an audit entry before and now do, specifically so this log isn't missing the actions people actually want to see.
- **Global search**: the search box in the top bar still filters the current page locally as before (Cards, Budgets, ...), and now also opens a dropdown of cross-app matches from `GET /api/search` — transactions, cards, budgets, bills, and claims across the whole company, not just the page you're on. Also derived on the fly from existing tables, nothing new persisted.
- Sidebar: "Products" (Accounts, Payments, Spend, Credit) and a separate "Settings" group (Subscription, Team, Business verification) — previously these were an unlabeled flat list. The six separate "coming soon" nav items (Policies, Payroll, EOR, and three Receivables sub-items) were consolidated into one "More products" link pointing to a proper roadmap page at `/soon`.
- Dashboard (Operation console): the old "Spend (as admin)" section re-exported the company-side Cards/Budgets/Claims/Receipts pages, but staff accounts belong to their own internal company, so those pages only ever showed empty data — removed (per-customer data lives at Customers → business detail, which already existed). The Approvals page is now read-only oversight — company Admins approve/reject Card, Budget, and Claim requests themselves on their own pages; staff can still delete requests (e.g. spam/test entries) but no longer approve/reject in parallel, which used to let two independent authorities act on the same request.

## Project structure

```
hoanglam-bank/
  backend/     # Express API + Prisma schema
  frontend/    # Next.js dashboard
```

## Prerequisites

- Node.js 20+
- PostgreSQL running locally (see below)

## Database

This was set up with a **native PostgreSQL 16 via Homebrew** (Docker Desktop wasn't installed on this machine):

```bash
brew install postgresql@16
brew services start postgresql@16
psql -d postgres -c "CREATE ROLE hoanglam LOGIN PASSWORD 'hoanglam' CREATEDB;"
psql -d postgres -c "CREATE DATABASE hoanglam_bank OWNER hoanglam;"
```

If you'd rather use Docker, a `backend/docker-compose.yml` is included as an alternative — just run `docker compose up -d` from `backend/` instead of the steps above (and skip the `brew` commands).

## Running the backend

```bash
cd backend
npm install
                        # backend/.env holds all config (gitignored) — edit if your DB creds differ.
                        # src/config/env.ts is the authoritative list of variables and their rules.
npx prisma migrate dev --name init
npx tsx prisma/seed.ts
npm run dev             # http://localhost:4000
```

## Running the frontend

```bash
cd frontend
npm install
npm run dev              # http://localhost:3000
```

`frontend/.env.local` points to `NEXT_PUBLIC_API_URL=http://localhost:4000/api`.

## Demo login

```
Admin (Demo Trading Co.): demo@lambank.dev / password123
Member (Demo Trading Co.): member@lambank.dev / password123
Bank staff, maker (cross-company): admin@lambank.dev / staff123
Bank staff, checker (cross-company): checker@lambank.dev / staff123
```

## Logging (Grafana + Loki)

Backend logs are structured JSON (`pino`), written to stdout and to `backend/logs/app.log` — every HTTP request/response plus unhandled errors. A local Grafana + Loki + Promtail stack ships them for browsing/querying:

```bash
docker compose -f docker-compose.logging.yml up -d
```

- Grafana: http://localhost:3001 (anonymous login, Admin role — no password needed)
- Go to **Explore** → datasource **Loki** → query `{job="backend"}` (or `{job="backend"} | json | level="error"` to filter errors)
- Frontend logs: run the dev server with `npm run dev:logged` (instead of `npm run dev`) from `frontend/` to also capture Next.js output to `frontend/logs/app.log`, queryable as `{job="frontend"}`

Config lives in `monitoring/` (Loki storage config, Promtail scrape config, Grafana's auto-provisioned Loki datasource). `docker compose -f docker-compose.logging.yml down` to stop; add `-v` to also wipe stored log history.

## Notes

- **Migration `20260808230000_recurring_autopay_card_controls_saved_payees` is required for Recurring transfers, Bill autopay, Card controls, and Saved payees.** It was written by hand (added `RecurringTransfer` and `SavedPayee` tables, `Bill.autopayAccountId`, and `Card.allowOnline`/`allowAtm`/`blockedCategories`) in an environment without registry access to run `prisma migrate dev`/`prisma generate` directly, so it could **not** be applied or type-checked against a live Prisma Client here. Before using those four features, run in `backend/`:
  ```bash
  npx prisma migrate dev
  npx prisma generate
  npm run dev
  ```
  If `npx tsc --noEmit` in `backend/` currently shows errors mentioning `recurringTransfer`, `savedPayee`, `autopayAccountId`, `allowOnline`, `allowAtm`, or `blockedCategories`, that's expected until you run the two commands above — the migration SQL and schema are correct, only the generated client is stale.
- **Migration `20260809030000_kyc_profile` is required for the mandatory onboarding wizard (`/onboarding`) and the Settings → verification flow it feeds into.** Hand-written `KycProfile` table + `KycIdType` enum, same situation as the migrations above — not yet applied here. Run the same `npx prisma migrate dev` / `npx prisma generate` / `npm run dev` steps in `backend/`; until then, `npx tsc --noEmit` shows errors mentioning `kycProfile` (on `PrismaClient` and on the `User` include in `auth.ts`), which is expected. After migrating, re-run `npx tsx prisma/seed.ts` to backfill an APPROVED `KycProfile` for the primary demo login (`demo@lambank.dev`) so it isn't sent through the wizard.
- **Migration `20260809010000_merchant_categories` is required for Categories (Settings → Categories, and the Card controls / simulate-purchase category pickers).** Same situation as above — hand-written `MerchantCategory` table, not yet applied here. Run the same `npx prisma migrate dev` / `npx prisma generate` / `npm run dev` steps in `backend/`; until then, `npx tsc --noEmit` will show 5 errors mentioning `merchantCategory` on `PrismaClient`, which is expected. After migrating, re-run `npx tsx prisma/seed.ts` to backfill a starter category list for Demo Trading Co. (it's additive/`skipDuplicates`, safe to re-run).
- All API routes except `/api/auth/register` and `/api/auth/login` require a `Bearer` JWT.
- Data is scoped per-company (`companyId`), so multiple companies registering won't see each other's data.
- Migrations `20260808190000_subscription_plans` and `20260808200000_kyb` add the subscription and KYB fields/tables. Run `npx prisma migrate dev` in `backend/` after pulling this change (existing companies default to the Free plan and NOT_STARTED verification).
- The Team/roles feature reuses the existing `User.role` column (no new migration) — re-run `npx tsx prisma/seed.ts` to get the new Member demo login if your DB was seeded before this change (it's additive and safe to re-run).
- Staff no longer use a separate `/dashboard/login` form — it now redirects to `/login`. Any account with `isStaff: true` sees an "Admin console" link in their account menu (top-right avatar) after logging in normally.
- **`ANTHROPIC_API_KEY` in `backend/.env` is required for both the Assistant chatbot and Claims receipt OCR** — it ships blank in `.env`. Without it, OCR fails silently in the UI (falls back to manual entry) except when the *company admin* is the one uploading, who'll see "OCR isn't configured yet" instead of a generic message. Get a key from console.anthropic.com and set it, then restart `npm run dev` in `backend/`.
- The Operation dashboard (bank staff console) moved from `/admin` to `/dashboard`.
- Migration `20260808210000_credit_lending` adds `Company.contractAcceptedAt` and the `CreditApply` / `Drawdown` / `Repayment` tables. Run `npx prisma migrate dev` in `backend/` after pulling this change, then re-run `npx tsx prisma/seed.ts` — it's additive and safe to re-run, and will backfill Demo Trading Co. with a seeded $50,000 approved credit line (KYB approved, contract signed, $20,000 drawn, $5,000 repaid) plus a second staff login (`checker@lambank.dev`) so maker-checker is testable locally. Existing companies otherwise default to no credit line and no signed contract.
- Migration `20260808220000_budget_freeze` adds a `FROZEN` value to `BudgetStatus`. Run `npx prisma migrate dev` in `backend/` after pulling this change. Also run `npx prisma generate` (or any `migrate dev`, which does it automatically) any time you pull schema changes — otherwise the backend's TypeScript types go stale.
- Added `qrcode` and `jsqr` to `frontend/package.json` for generating/reading QR codes client-side — already installed, but run `npm install` in `frontend/` if you're pulling this onto a machine that hasn't had it run yet.
- All transfer/QR-pay endpoints now require an `otp` field; the demo/mock code is always `8888`.
