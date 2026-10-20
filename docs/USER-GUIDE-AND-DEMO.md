# LamBank — Overview, User Guide and Demo Script

This document is for people new to the project: what LamBank is, how to run it,
and how to demo it in ~15 minutes. For backend architecture details see `docs/BACKEND-ARCHITECTURE.md`.

---

## 1. What LamBank is

LamBank is a full build of a **business banking** product (inspired by Aspire):
a company signs up, gets verified, funds its account, issues cards to employees,
sets spending limits, approves expense claims, pays supplier bills, then borrows and repays
against a credit line. Alongside that is the **bank's operations console**, where staff
review KYB applications, grant credit lines under a maker–checker process, and browse the audit log.

Data is isolated by `companyId`; within each company there are two roles, Admin/Member, so most
actions that touch money go through a request – approval workflow.

| Role | Permissions |
| --- | --- |
| ADMIN | Acts directly; approves Member requests; signs the credit contract. At most 4 Admins per company. |
| MEMBER | Creates cards/budgets/claims as *requests* awaiting Admin approval. |
| isStaff | `/dashboard` console: customers, KYB queue, credit applications (maker ≠ checker), audit log, interbank treasury. |

### Sandbox conventions (keep in mind when demoing)

- There is no real banking rail — money enters the system via the **Add funds** button on the Cash page (up to $1,000,000 per request).
- The OTP code for every transfer is always **8888**.
- KYC and KYB are **auto-approved** as soon as they're submitted; the staff manual review queue still works.
- There is no background worker: recurring transfers, bill autopay, deposit interest and loan auto-deduct
  all run **lazily** — they only trigger when someone opens the corresponding page.
- Cards are not connected to a real card network — use **Simulate a purchase** to verify the card control rules.

---

## 2. Architecture

```
Browser (Next.js App Router, Tailwind)
        │  HTTP JSON /api/...
        ▼
   middleware      helmet · CORS · pino · rate limit · JWT → req.companyId
        ▼
   *.routes.ts     input validation with zod, no business logic
        ▼
   *.service.ts    all business rules
        ▼
   *.repository.ts the only place allowed to call prisma
        ▼
   PostgreSQL      ~45 models, partitioned by companyId
```

```
hoanglam-bank/
├── backend/          Express API + Prisma (28 migrations, seed.ts)
│   └── src/features/ banking · spend · lending · compliance · backoffice · platform
├── frontend/         Next.js: (app) for companies, /dashboard for bank staff
├── e2e/              Playwright: tests/api (HTTP) + tests/ui (browser)
├── monitoring/       Loki · Promtail · Grafana
└── docs/             Backend architecture, Node.js learning notes, this file
```

Worth noting: a shared audit log for every action that touches money; transaction velocity checks +
flagging of anomalous transactions (5× the average of the last 10 transactions); deposit interest
CHECKING 0% / SAVINGS 2% / MONEY_MARKET 3.5% ACT/365; three rate-limit tiers (auth, general,
public API `/api/v1` authenticated with an `lb_live_…` API key); the assistant's knowledge lives in
`backend/src/knowledge/app-guide.md` and is re-read on every request.

---

## 3. Feature map

**Accounts & cash flow**
- `/accounts/cash` — balance per account; account types Checking / Savings (2%/year) /
  Money Market (3.5%/year), simple interest ACT/365 posted lazily when the page is opened; set an **overdraft limit**
  (up to $50,000, $35 fee each time the balance goes from positive to negative); simulated deposits; open additional accounts.
- `/accounts/transactions` — filter by type/category/date range, grouped by day, CSV export. Transactions that are
  unusually large compared with the account's history are **flagged ⚑** (warning only, not blocked).
- `/accounts/statement` — printable monthly statement: opening/closing balance, money in/out, every transaction.
- `/accounts/reports` — monthly cash in/out and spend breakdown by category, 3/6/12-month period.
- `/transfer` — one page for all four modes: **Internal** (account number or QR image), **FX**
  (simulated conversion, 0.5% fee/spread), **Wire** (bank name + routing/SWIFT, flat $25 fee),
  **Receive via QR** (your own QR code, downloadable, with amount + note embedded).
  Every outgoing payment goes through a **Review** step and then **OTP `8888`**. `/payments/qr` now just redirects here.
- `/transfer/recurring` — weekly/monthly transfer schedules, run lazily when the page is opened.
- `/payments/bills` — utility bills by customer code (EVN, Sawaco, FPT, tuition, insurance);
  over $1,000 requires approved KYB.

**Business spend**
- `/spend/cards` — virtual / physical / prepaid cards, freeze, assign to a budget, toggle online & ATM,
  block merchant categories, and **Simulate a purchase** to verify the rules. Physical cards require approved KYB.
- `/spend/budgets` — per-period limits, edit/freeze; total budgets can't exceed the actual cash available.
- `/spend/claims` — receipt OCR (images and PDF) with Claude, bulk upload of up to 20 files, currency picker,
  and a **Receipt library** tab to reuse previously uploaded receipts.
- `/spend/bills` — supplier bills: pay for real from an account, or turn on autopay when due.
- `/spend/policies` — card limit cap, budget cap, **mandatory approval threshold** (applies to Admins too),
  claim flagging threshold (default $500), and a limit on the number of transactions within a time window
  (exceeding it is **blocked**, unlike the anomaly flag above, which only warns). Has a reset-to-defaults button.

**Credit**
- `/credit` — sign the contract, then **submit a credit line application yourself** right here (bank staff can
  also submit on the company's behalf). The application goes through two stages: the **maker** reviews a *risk snapshot*
  (recent cash flow, overdue bills, requested amount vs. average cash inflow — computed from the company's own data)
  and forwards it; the **checker** — who must be a different person — finalizes the limit, interest rate and term.
- **Drawdown** — checks the *conditions precedent* (KYB approved, contract signed, limit approved, no overdue
  installments, at least one non-frozen account), records the purpose, fixes the maturity date, and charges a 0.5% fee
  as a separate debit. Pick one of four repayment methods: **Revolving** (repay freely), **Amortizing** (equal
  installments), **Interest-only** (monthly interest, principal at maturity), **Balloon** (small monthly payments,
  large final payment). The three scheduled methods allow a 0–6 month grace period and **auto-deduct**.
- **Repayment** — for loans with a schedule, money is allocated in the order late fee → interest → principal, earliest
  due installment first; any overpayment prepays the principal of the next installment. Overdue installments incur a
  **one-time 2% late fee**.
- `/lending` — interbank treasury desk: counterparty directory (SWIFT + a separate limit per party),
  **Unsecured** or **Repo** loans (collateral must cover at least the principal), terms from overnight → 1 year,
  simple interest ACT/365, manual settlement (early settlement charges interest for the actual days held), mark as
  defaulted, and the bank's own capital ledger. If the database is empty there's a button to generate sample data.

**Verification & approvals**
- `/onboarding` — a mandatory 5-step wizard for a newly registered Admin: personal KYC → business profile →
  beneficial owners → documents → submit. Staff and Members skip it.
- `/settings/verification` — KYB status. Until approved: physical cards are blocked, transactions over $1,000 are
  blocked, and the Transfer page is locked entirely.
- Notification bell — Member card/budget/claim requests, bills due soon or overdue,
  frozen budgets, credit lines approved but not yet signed, and user-defined alerts.

**Platform**
- `/settings/team` — add/remove members, promote/demote, at most 4 Admins.
- `/settings/subscription` — Free / Pro / Business: limits on cards, budgets, claims per month,
  and the fee discount level.
- `/settings/alerts` — **low balance** rules (against the current balance) or **large transaction** rules (debits in
  the last 24 hours), per account or for all accounts; can be paused without losing the configured threshold.
- `/settings/activity` — log of actions taken by people in the company.
- `/settings/developer` — **API keys** (shown in full exactly once at creation, call `/api/v1/...` with the
  `x-api-key` header, currently read-only for accounts and transactions) and **webhooks** (each endpoint has its own
  HMAC-SHA256 signing secret, shown once; the *Send test* button fires a real request and records the result in the
  Deliveries tab).
- `/settings/categories` — the company's merchant category list, used for card controls and transaction labeling.
- `/settings/test-data` — generate 1–24 months of transaction history or wipe it all (only runs outside production).
- Search box in the top bar — filters the current page and also returns results from across the whole company.

## 4. Installation & running

Requirements: Node.js 20+, PostgreSQL 16.

```bash
# 1. Database
brew install postgresql@16 && brew services start postgresql@16
psql -d postgres -c "CREATE ROLE hoanglam LOGIN PASSWORD 'hoanglam' CREATEDB;"
psql -d postgres -c "CREATE DATABASE hoanglam_bank OWNER hoanglam;"
# or: cd backend && docker compose up -d

# 2. Backend (port 4000)
cd backend
npm install
npx prisma migrate dev
npx prisma generate      # skip this and the Prisma Client goes stale, TypeScript reports errors
npm run seed
npm run dev

# 3. Frontend (port 3000)
cd frontend
npm install
npm run dev              # npm run dev:logged to write logs to frontend/logs/app.log
```

Environment variables:

| Variable | File | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | backend/.env | PostgreSQL connection string |
| `JWT_SECRET` | backend/.env | ≥ 16 characters; placeholders are rejected when `NODE_ENV=production` |
| `ANTHROPIC_API_KEY` | backend/.env | Enables the assistant + receipt OCR; leave empty and these two features are skipped |
| `CORS_ORIGIN` | backend/.env | Defaults to `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL` | frontend/.env.local | Defaults to `http://localhost:4000/api` |
| `NEXT_PUBLIC_ENABLE_DEMO_TOOLS` | frontend/.env.local | `true` to show the data reset button, credit auto-approval, and the OTP code on screen. **Must be off in a real environment.** |

Testing and logs:

```bash
cd backend && npm test            # vitest: interest, overdraft, FX, transfers, repayment
cd frontend && npm test
cd e2e && npm install && npm run install:browsers && npx playwright test
docker compose -f docker-compose.logging.yml up -d   # Grafana: localhost:3001
```

---

## 5. Demo accounts

Everyone logs in through the same `/login` page; staff accounts additionally see "Admin console" in the avatar menu.

| Email | Password | Role | Used for |
| --- | --- | --- | --- |
| `demo@lambank.dev` | password123 | ADMIN | Main company: KYB approved, balance $128,450, credit line $50,000 ($20,000 drawn, $5,000 repaid) |
| `member@lambank.dev` | password123 | MEMBER | Demonstrating the request – approval workflow |
| `hoa@lambank.dev` | password123 | ADMIN | Second company (`US-0002-7734`), **deliberately unverified** → demonstrates the onboarding wizard, and acts as the recipient for transfers |
| `admin@lambank.dev` | staff123 | STAFF (maker) | Prepares credit applications, approves KYB, audit log |
| `checker@lambank.dev` | staff123 | STAFF (checker) | Approves credit applications — must be a different person from the preparer |

---

## 6. 15-minute demo script

Preparation: both servers running, DB seeded, one normal window + one incognito window open
so you can switch roles without constantly logging out.

1. **Money into the account** — `demo@lambank.dev` → `/accounts/cash` → *Add funds* $25,000.
   The balance increases immediately and a CREDIT transaction is created.
   *Key point:* this is the only place money comes "from outside" into the system; every figure afterwards
   originates from real Transactions.

2. **Transfer with OTP** — `/transfer` → Internal → `US-0002-7734` → $3,000 → Review → OTP `8888`.
   Try the 25%/50%/Max quick buttons. Afterwards go back to Transactions to see the DEBIT; the recipient becomes a
   "recent recipient". All four modes live on the same page: *Internal*, *FX* (0.5% fee),
   *Wire* (flat $25 fee), *Receive via QR* — the last one generates your own QR code;
   upload that image on the Internal tab and the amount and note are filled in automatically.

3. **Cards, budgets and control rules** — create a "Marketing Q4" budget of $10,000, issue a virtual card
   attached to it, turn off *Allow online* or block a merchant category, then *Simulate a purchase* twice:
   one transaction approved (increasing the card's and budget's spent amount) and one declined.
   *If you want to talk about risk controls:* `/spend/policies` sets a mandatory approval threshold — above it,
   even Admins have to go through the queue.

4. **Request – approval** — in the incognito window, `member@lambank.dev` creates a card → only a request is created.
   Back in the Admin window, the bell shows a badge → approve in place → reload the Member page to see the card now exists.

5. **Expense claims + OCR** — `/spend/claims`, upload a receipt image/PDF, Claude fills in the title, amount and
   currency automatically; submit and approve. *Without an API key, say so up front and enter it manually.*

6. **Bills** — `/spend/bills` create one and *Pay bill* (a real debit), turn on autopay for another bill;
   then `/payments/bills` pay a utility bill by customer code (discount depends on the plan).

7. **Credit: maker – checker – drawdown – repayment** — as the company at `/credit`, sign the contract and then
   submit a credit line application yourself. Log in as `admin@lambank.dev` → `/dashboard/credit-applies`: review the
   *risk snapshot* and forward the application to the approval stage (trying to approve it yourself is blocked). Log in as
   `checker@lambank.dev` to finalize the limit, interest rate and term. Back on `/credit`: check the conditions
   precedent list, draw down funds (pick a repayment method — Revolving for speed, or Amortizing to show the
   installment schedule), see the 0.5% drawdown fee as a separate debit, then make a partial repayment and watch the
   money being allocated late fee → interest → principal.

8. **Onboarding/verification** — log in as `hoa@lambank.dev`: you're taken into the 5-step wizard
   (KYC → business profile → beneficial owners → documents → submit); once submitted it's auto-approved.
   Before approval: the transfer button is locked and transactions > $1,000 are blocked.

9. **Wrap up with the admin side** — `/accounts/reports` (cash flow + spend breakdown, computed from the very
   transactions just created) · global search in the top bar · `/settings/activity`
   (every action just taken is there) · `/dashboard` (customers, KYB, audit log, treasury).
   *To demo again from scratch:* `/settings/test-data` to regenerate or wipe the data.

---

## 7. API reference

Every route except `/api/auth/register` and `/api/auth/login` requires the `Authorization: Bearer <JWT>` header.
The public API `/api/v1` uses an `lb_live_…` API key instead of a JWT.

| Prefix | Contents | Access |
| --- | --- | --- |
| `/api/auth` | Register, log in | Public |
| `/api/accounts` | Accounts, transactions, statements, reports, deposits | Logged in (deposits: Admin) |
| `/api/transfers` | Internal, FX, recurring | Logged in + OTP |
| `/api/payments`, `/api/payees` | Utilities, payees | Logged in |
| `/api/cards`, `/api/budgets`, `/api/claims`, `/api/bills`, `/api/categories`, `/api/spend-policy` | Spend | Write: Admin · Read: any member |
| `/api/credit`, `/api/drawdown`, `/api/repayment` | Credit | Admin, after KYB is approved |
| `/api/kyc`, `/api/kyb`, `/api/approvals` | Verification, approvals | Admin / staff |
| `/api/admin`, `/api/activity`, `/api/interbank` | Bank console | isStaff |
| `/api/notifications`, `/api/alerts`, `/api/search`, `/api/assistant` | Platform utilities | Logged in |
| `/api/developer`, `/api/v1` | API keys, webhooks, public API | Admin · API key |
| `/api/health` | Health check (no rate limit) | Public |

```bash
TOKEN=$(curl -s localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@lambank.dev","password":"password123"}' | jq -r .token)

curl -s localhost:4000/api/accounts -H "Authorization: Bearer $TOKEN" | jq
```

---

## 8. Common issues

- **TypeScript errors on `recurringTransfer`, `kycProfile`, `merchantCategory`…** — stale Prisma Client.
  Run `npx prisma migrate dev` and then `npx prisma generate` in `backend/`.
- **OTP doesn't go through** — the code is fixed at `8888`; set `NEXT_PUBLIC_ENABLE_DEMO_TOOLS=true` to see it on screen.
- **Transfer button locked / transactions > $1,000 blocked** — the KYB gate, working as designed.
  Complete `/settings/verification` (the sandbox approves it immediately).
- **Assistant is silent, OCR doesn't auto-fill** — `ANTHROPIC_API_KEY` is missing from `backend/.env`; fill it in and restart.
- **Recurring transfers / autopay don't run on their own** — there's no worker; they run lazily when the corresponding page is opened.
- **Demo accounts missing** — `npm run seed` in `backend/` (safe to re-run many times).
- **Can't draw down** — check the conditions precedent list on the Credit page: KYB approved,
  contract signed, limit approved, no overdue installments, and at least one non-frozen account.
- **Transaction blocked with the message "try again shortly"** — you've hit the transaction-count limit for the time
  window set in `/spend/policies`. Leave that field empty to remove the limit.
- **Viewing error logs** — `backend/logs/app.log`, or Grafana: `docker compose -f docker-compose.logging.yml up -d`
  → localhost:3001 → Explore → Loki → `{job="backend"} | json | level="error"`.
