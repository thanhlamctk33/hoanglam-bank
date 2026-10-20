#!/usr/bin/env node
/**
 * Checks the environment BEFORE a healing run, because most of what looks
 * like a broken suite is a missing backend or an unseeded database — and an
 * agent that starts editing specs in that state does real damage.
 *
 * No dependencies: Node 20's global fetch, and the same env variables the
 * suite itself reads (utils/env.ts).
 */

const API_ORIGIN = (process.env.E2E_API_URL || "http://localhost:4000").replace(/\/$/, "");
const WEB_URL = (process.env.E2E_WEB_URL || "http://localhost:3000").replace(/\/$/, "");
const API = `${API_ORIGIN}/api`;
const SEEDED = [
  { email: process.env.E2E_USER_EMAIL || "demo@lambank.dev", password: process.env.E2E_USER_PASSWORD || "password123", role: "company ADMIN" },
  { email: process.env.E2E_MEMBER_EMAIL || "member@lambank.dev", password: process.env.E2E_MEMBER_PASSWORD || "password123", role: "company MEMBER" },
  { email: process.env.E2E_STAFF_EMAIL || "admin@lambank.dev", password: process.env.E2E_STAFF_PASSWORD || "staff123", role: "bank staff (maker)" },
  { email: process.env.E2E_CHECKER_EMAIL || "checker@lambank.dev", password: process.env.E2E_CHECKER_PASSWORD || "staff123", role: "bank staff (checker)" },
];

const problems = [];
const notes = [];

async function reachable(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const skipServers = process.env.E2E_NO_SERVER !== "1";

let checkedLogins = false;

const health = await reachable(`${API}/health`);
if (!health.ok) {
  if (skipServers) {
    notes.push(`Backend is not up at ${API} yet — Playwright will start it itself (E2E_NO_SERVER is unset).`);
  } else {
    problems.push(
      `Backend is not answering at ${API} and E2E_NO_SERVER=1 says you are running it yourself.\n` +
        `      Start it:  cd ../backend && npm run dev`
    );
  }
} else if (health.status >= 400) {
  problems.push(`GET ${API}/health answered ${health.status}. The backend is up but unhealthy.`);
}

// Seeded logins are only checkable once something is listening.
if (health.ok && health.status < 400) {
  checkedLogins = true;
  for (const account of SEEDED) {
    const res = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: account.email, password: account.password }),
    }).catch((err) => ({ status: 0, error: err }));

    if (res.status === 401) {
      problems.push(
        `Seeded login rejected: ${account.email} (${account.role}).\n` +
          `      Fix:  cd ../backend && npm run seed`
      );
    } else if (res.status === 429) {
      problems.push(
        `The auth rate limiter is throttling (429) for ${account.email}.\n` +
          `      With E2E_NO_SERVER=1 you must export the ceilings yourself:\n` +
          `      AUTH_RATE_LIMIT_MAX=1000 GENERAL_RATE_LIMIT_MAX=5000`
      );
      break;
    } else if (res.status !== 200) {
      problems.push(`POST /auth/login for ${account.email} answered ${res.status}.`);
    }
  }
}

const web = await reachable(WEB_URL);
if (!web.ok && !skipServers) {
  problems.push(
    `Frontend is not answering at ${WEB_URL} and E2E_NO_SERVER=1 says you are running it yourself.\n` +
      `      Start it:  cd ../frontend && npm run dev`
  );
}

for (const note of notes) console.log(`note   ${note}`);

if (problems.length > 0) {
  console.error("\nPreflight failed. Fix the environment before touching any spec:\n");
  for (const problem of problems) console.error(`  ✗   ${problem}`);
  console.error(
    "\nEvery one of these makes the whole suite red for a reason that has nothing\n" +
      "to do with the tests. Editing specs now would be fixing the wrong thing.\n"
  );
  process.exit(1);
}

// Say only what was actually verified. Claiming the seeded logins are fine
// when the backend was never reached is exactly the kind of false all-clear
// this script exists to prevent.
if (checkedLogins) {
  console.log("Preflight OK — backend reachable, all four seeded logins accepted.");
} else {
  console.log(
    "Preflight OK — nothing to verify yet: Playwright will start the servers itself.\n" +
      "       The seeded logins are therefore UNCHECKED. If the run fails at fixture setup,\n" +
      "       the database is the first thing to suspect: cd ../backend && npm run seed"
  );
}
