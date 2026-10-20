import { test as base } from "@playwright/test";
import { Account, ApiClient, AuthResponse } from "../utils/api-client";
import { SANDBOX_OPENING_BALANCE } from "../utils/env";
import { NEW_COMPANY_PASSWORD } from "../utils/data";
import { withSetupHint } from "./roles";

/**
 * WHERE THE MONEY LIVES.
 *
 * `sandbox` is the fixture for anything that asserts on a balance: two
 * freshly registered companies — a funded `payer` and an empty `payee` — that
 * nothing else in the suite can see. An assertion like "the source account is
 * now exactly `before - amount`" therefore cannot be broken by another spec
 * spending the same money on another worker.
 *
 * Cross-company semantics survive: payer and payee really are separate
 * tenants, the way a transfer is meant to work, and `payee` doubles as the
 * "not your account" subject in the negative specs.
 *
 * Reach for `adminApi` instead when the spec is about the seeded company's
 * own history; reach for `sandbox` the moment arithmetic on a balance is
 * involved.
 *
 * Worker-scoped rather than test-scoped: a worker only ever runs one test at
 * a time, so one sandbox per worker is already race-free, and it costs two
 * registrations per worker instead of two per test.
 */
export interface Sandbox {
  /** Registered, then funded with SANDBOX_OPENING_BALANCE. */
  payer: SandboxCompany;
  /** Registered and left empty. */
  payee: SandboxCompany;
}

export interface SandboxCompany {
  api: ApiClient;
  /**
   * An IDENTITY handle. Its `balance` is only the opening figure captured at
   * worker start — always re-read the live balance mid-spec rather than doing
   * arithmetic against this snapshot.
   */
  account: Account;
}

export interface SandboxWorkerFixtures {
  sandbox: Sandbox;
}

/**
 * A funded company of this test's very own.
 *
 * `sandbox` is shared by every test in a worker, which is fine for moving
 * money — balances go up and down — but wrong for anything that CREATES
 * things, because a new company lands on the FREE plan and the FREE plan
 * counts: 3 active cards, 2 active budgets, 5 expense claims a month
 * (backend/src/features/platform/subscription/plans.config.ts). Spread the
 * Spend specs across a shared company and they start failing with 402
 * "plan limit reached" in whatever order they happened to run.
 *
 * `fundedCompany` is therefore test-scoped: one registration plus one wire-in
 * per test, and every quota starts fresh. It is also the right subject for a
 * spec that asserts ON the cap, since it can count from zero.
 */
export interface FundedCompany {
  api: ApiClient;
  /** The company's primary USD account, funded at fixture setup. */
  account: Account;
  /** token, user and company, for specs that need the ids. */
  auth: AuthResponse;
  /**
   * The literal password this company was registered with. Card freeze and
   * card reveal ask for it again as a confirmation step.
   */
  password: string;
}

export interface SandboxTestFixtures {
  fundedCompany: FundedCompany;
}

export const sandboxTest = base.extend<SandboxTestFixtures, SandboxWorkerFixtures>({
  sandbox: [
    async ({}, use) => {
      const [payer, payee] = await withSetupHint("sandbox", () =>
        Promise.all([ApiClient.registerNewCompany(), ApiClient.registerNewCompany()])
      );

      // Registration provisions one USD account per company; the payer's is
      // then funded through the sandbox wire-in endpoint.
      const payerAccountId = (await payer.client.firstAccount("USD")).id;
      await payer.client.post(`/accounts/${payerAccountId}/deposit`, {
        amount: SANDBOX_OPENING_BALANCE,
      });

      await use({
        payer: { api: payer.client, account: await payer.client.firstAccount("USD") },
        payee: { api: payee.client, account: await payee.client.firstAccount("USD") },
      });

      await payer.client.dispose();
      await payee.client.dispose();
    },
    { scope: "worker" },
  ],

  fundedCompany: async ({}, use) => {
    const { client, auth } = await withSetupHint("fundedCompany", () =>
      ApiClient.registerNewCompany()
    );

    const account = await client.firstAccount("USD");
    await client.post(`/accounts/${account.id}/deposit`, { amount: SANDBOX_OPENING_BALANCE });

    await use({
      api: client,
      // Re-read so `account.balance` reflects the deposit rather than the
      // zero balance registration handed back.
      account: await client.firstAccount("USD"),
      auth,
      password: NEW_COMPANY_PASSWORD,
    });

    await client.dispose();
  },
});
