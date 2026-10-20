# LamBank

**A practice business-banking app for small companies, with simulated money.**

Think of it as a mini [Aspire](https://aspireapp.com): a company signs up, gets verified, puts money
in its account, gives cards to its staff, and pays its bills. Bank staff work in a separate
console where they check new companies and approve credit lines.

> ⚠️ **Nothing here is real money.** There is no connection to a real bank or card network.
> The OTP code for every transfer is always **`8888`**.

---

## Contents

1. [What you can do](#1-what-you-can-do)
2. [Run it on your machine](#2-run-it-on-your-machine)
3. [Demo accounts](#3-demo-accounts)
4. [Settings (.env)](#4-settings-env)
5. [Project structure](#5-project-structure)
6. [Running the tests](#6-running-the-tests)
7. [Viewing logs (optional)](#7-viewing-logs-optional)
8. [More documentation](#8-more-documentation)

---

## 1. What you can do

**As a company (customer side)**

- Sign up and get verified (KYB)
- Add funds and transfer money
- Issue cards to staff and set spending limits
- Approve expense claims and pay vendor bills
- Borrow from a credit line and pay it back

**As bank staff (back-office console at `/dashboard`)**

- Review company verification (KYB) requests
- Approve credit lines — one person proposes, a *different* person approves (maker–checker)
- Read the audit log of who did what

---

## 2. Run it on your machine

### What you need first

- **Node.js 20** or newer
- **PostgreSQL 16** (installed directly, or via Docker)

### Step 1 — Start the database

Pick **one** of the two options.

**Option A: Docker** (easiest if you have Docker)

```bash
cd backend
docker compose up -d
```

**Option B: Homebrew (macOS)**

```bash
brew install postgresql@16
brew services start postgresql@16
psql -d postgres -c "CREATE ROLE hoanglam LOGIN PASSWORD 'hoanglam' CREATEDB;"
psql -d postgres -c "CREATE DATABASE hoanglam_bank OWNER hoanglam;"
```

### Step 2 — Start the backend (API)

```bash
cd backend
cp .env.example .env     # only the first time
npm install
npx prisma migrate dev   # create the tables
npx prisma generate      # don't skip — otherwise the Prisma Client is out of date
npm run seed             # add the demo accounts
npm run dev
```

✅ The API is now running at **http://localhost:4000**

### Step 3 — Start the frontend (website)

Open a **new terminal**, then:

```bash
cd frontend
npm install
npm run dev
```

✅ Open **http://localhost:3000** and log in with one of the [demo accounts](#3-demo-accounts) below.

---

## 3. Demo accounts

These are created by `npm run seed`. Everyone logs in at **`/login`**.
Staff accounts get an **"Admin console"** link in the avatar menu.

**Company accounts** — password `password123`

| Email | Role | Use it to… |
| --- | --- | --- |
| `demo@lambank.dev` | Admin | Try everything. Already verified, funded, and has a $50,000 credit line. |
| `member@lambank.dev` | Member | See the approval flow — anything this user creates needs an Admin to approve it. |
| `hoa@lambank.dev` | Admin | Walk through sign-up from scratch. This company (`US-0002-7734`) is not verified yet. |

**Bank staff accounts** — password `staff123`

| Email | Role | Use it to… |
| --- | --- | --- |
| `admin@lambank.dev` | Staff (maker) | Review KYB, propose credit lines, read the audit log. |
| `checker@lambank.dev` | Staff (checker) | Approve credit lines. You can't approve your own proposal, so you need both staff logins. |

---

## 4. Settings (.env)

| File | What it's for |
| --- | --- |
| `backend/.env` | Backend settings. Copy from `backend/.env.example`. The full list is checked at startup in `backend/src/config/env.ts`. |
| `frontend/.env.local` | Frontend settings. |

Two settings worth knowing about:

| Variable | Where | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | backend | Turns on the in-app AI assistant and receipt scanning. Empty by default — the app still works without it, those two features just switch off. |
| `NEXT_PUBLIC_ENABLE_DEMO_TOOLS=true` | frontend | Shows demo helpers: reset buttons, one-click credit approval, and the OTP on screen. **Never turn this on in a real deployment.** |

---

## 5. Project structure

```
hoanglam-bank/
├── backend/      API server (Express + Prisma) — database schema, migrations, seed data
├── frontend/     Website (Next.js) — customer app, plus /dashboard for bank staff
├── e2e/          End-to-end tests (Playwright) — API tests and browser tests
├── monitoring/   Log viewer setup (Grafana + Loki)
└── docs/         Guides and design notes
```

Backend code is grouped by business area in `backend/src/features/`:

| Folder | Covers |
| --- | --- |
| `banking` | Accounts, transfers, payees, interest |
| `spend` | Cards, budgets, expense claims, bills |
| `lending` | Credit lines, drawdowns, repayments |
| `compliance` | KYB / KYC checks, approvals |
| `backoffice` | Bank staff console, activity log |
| `platform` | Login, team, notifications, search, AI assistant |

**Tech stack**

- **Backend:** Node.js, Express, TypeScript, Prisma, PostgreSQL, JWT, pino
- **Frontend:** Next.js (App Router), React 19, Tailwind CSS
- **Tests:** Vitest (unit tests), Playwright (end-to-end)

---

## 6. Running the tests

```bash
# Backend unit tests (interest, overdraft, FX, transfers, repayment)
cd backend && npm test

# Frontend unit tests
cd frontend && npm test

# End-to-end tests — backend and frontend must be running first
cd e2e
npm install
npm run install:browsers   # only the first time
npx playwright test
```

---

## 7. Viewing logs (optional)

The backend writes logs to the terminal and to `backend/logs/app.log`.
To search them in a web page, start the log stack (needs Docker):

```bash
docker compose -f docker-compose.logging.yml up -d
```

Then:

1. Open **http://localhost:3001** (Grafana, no login needed)
2. Go to **Explore → Loki**
3. Type a query:
   - All backend logs: `{job="backend"}`
   - Errors only: `{job="backend"} | json | level="error"`

To include frontend logs too, start the frontend with `npm run dev:logged` and query `{job="frontend"}`.

To stop it and delete the saved logs:

```bash
docker compose -f docker-compose.logging.yml down -v
```

---

## 8. More documentation

| Document | Read it when you want… |
| --- | --- |
| [`docs/HUONG-DAN-SU-DUNG-VA-DEMO.md`](docs/HUONG-DAN-SU-DUNG-VA-DEMO.md) | **Start here** — overview, feature map, and a 15-minute demo script |
| [`docs/KIEN-TRUC-BACKEND.md`](docs/KIEN-TRUC-BACKEND.md) | How the backend is organized and how a request flows through it |
| [`docs/GHI-CHU-THIET-KE.md`](docs/GHI-CHU-THIET-KE.md) | Details on each feature and why it was designed that way |
| [`frontend/NAMING-CONVENTIONS.md`](frontend/NAMING-CONVENTIONS.md) | Naming rules for frontend code |
| [`e2e/README.md`](e2e/README.md) | How the end-to-end tests are organized and run |
