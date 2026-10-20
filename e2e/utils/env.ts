/**
 * Single source of truth for every host, credential and magic constant the
 * tests need. Everything is overridable through environment variables so the
 * same suite can run against a local `npm run dev` pair or a deployed stack.
 */

function envStr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

/** Next.js frontend. `next dev` binds 3000 by default. */
export const WEB_BASE_URL = envStr("E2E_WEB_URL", "http://localhost:3000");

/** Express backend root (no `/api` suffix — helpers add it). */
export const API_ORIGIN = envStr("E2E_API_URL", "http://localhost:4000");

/** Prefix every backend route is mounted under in backend/src/index.ts. */
export const API_BASE_URL = `${API_ORIGIN}/api`;

/**
 * Seeded demo company admin — created by `backend/prisma/seed.ts`.
 * Run `npm run seed` in backend/ before the suite if the DB is empty.
 */
export const DEMO_USER = {
  email: envStr("E2E_USER_EMAIL", "demo@lambank.dev"),
  password: envStr("E2E_USER_PASSWORD", "password123"),
};

/** Second seeded customer, used for transfer-recipient assertions. */
export const SECOND_USER = {
  email: envStr("E2E_USER2_EMAIL", "hoa@lambank.dev"),
  password: envStr("E2E_USER2_PASSWORD", "password123"),
  accountNumber: envStr("E2E_USER2_ACCOUNT", "US-0002-7734"),
};

/**
 * Seeded non-admin teammate inside the SAME company as DEMO_USER.
 * Role MEMBER, so anything they create lands in the approval queue — which is
 * what makes the maker/checker specs possible.
 */
export const MEMBER_USER = {
  email: envStr("E2E_MEMBER_EMAIL", "member@lambank.dev"),
  password: envStr("E2E_MEMBER_PASSWORD", "password123"),
};

/**
 * Seeded back-office operator, for the /dashboard console.
 *
 * Note the password: `backend/prisma/seed.ts` hashes "staff123" for both
 * staff accounts, not the "password123" every customer account uses. This
 * default was wrong until now, which meant the staff half of auth.setup.ts
 * (and the "refuses a staff account on the customer gate" spec) was signing
 * in with the wrong credentials.
 */
export const STAFF_USER = {
  email: envStr("E2E_STAFF_EMAIL", "admin@lambank.dev"),
  password: envStr("E2E_STAFF_PASSWORD", "staff123"),
};

/**
 * A SECOND seeded operator. Credit Apply is maker/checker between two staff
 * members — the same person may not forward and then approve — so the
 * back-office specs need two distinct staff identities to exercise it.
 */
export const CHECKER_USER = {
  email: envStr("E2E_CHECKER_EMAIL", "checker@lambank.dev"),
  password: envStr("E2E_CHECKER_PASSWORD", "staff123"),
};

/**
 * Fixed OTP the demo build accepts for money movement.
 * Mirrors MOCK_OTP in backend/src/shared/otp/otp.service.ts.
 */
export const DEMO_OTP = envStr("E2E_OTP", "8888");

/** localStorage key the frontend stores the JWT under (see lib/auth-context.tsx). */
export const TOKEN_STORAGE_KEY = envStr("E2E_TOKEN_KEY", "hoanglam-bank-token");

/** Where the shared logged-in browser state is cached between projects. */
export const STORAGE_STATE_PATH = ".auth/user.json";
export const STAFF_STORAGE_STATE_PATH = ".auth/staff.json";

/** Set E2E_NO_SERVER=1 when the backend/frontend are already running. */
export const REUSE_RUNNING_SERVERS = process.env.E2E_NO_SERVER === "1";

/**
 * Opening balance wired into the `sandbox` fixture's payer account.
 *
 * Big enough that no spec can drain it over a full run, and big enough that
 * the "amount beyond the available balance" specs still fail on the balance
 * check rather than on the KYB per-transaction ceiling. Well under the
 * 1,000,000 cap on POST /accounts/:id/deposit.
 */
export const SANDBOX_OPENING_BALANCE = Number(
  envStr("E2E_SANDBOX_BALANCE", "50000")
);
