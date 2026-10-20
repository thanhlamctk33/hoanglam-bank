import type { APIResponse } from "@playwright/test";
import { test, expect } from "../../fixtures/test";
import { Account, ApiClient } from "../../utils/api-client";
import { API_BASE_URL, DEMO_OTP } from "../../utils/env";
import { uniqueSuffix } from "../../utils/data";

/**
 * /api/kyb — business verification: the customer-facing wizard, and the
 * payment ceiling it exists to lift.
 *
 * Two things make this file shaped the way it is.
 *
 * First, KYB is company-wide state that other specs read. The seeded demo
 * company is APPROVED by `prisma/seed.ts` and half the suite depends on that
 * (any spec moving more than $1,000 would start failing the moment it wasn't),
 * and the worker-scoped `sandbox` pair is shared by every test in the worker.
 * So nothing here ever mutates either: every mutating test runs against
 * `outsiderApi` — a company registered for that one test — or against a pair
 * of companies it registers and disposes itself.
 *
 * Second, the wizard is a state machine with a lock. `assertEditable()` in
 * kyb.service.ts refuses every edit once the status leaves the editable
 * states, and `submitKyb()` refuses to submit unless all three pieces
 * (profile, at least one beneficial owner, a BUSINESS_REGISTRATION document)
 * are present. Each of those refusals gets its own test, because each is a
 * separate `if` in the service and they can regress independently.
 *
 * The last describe is the point of the whole file. `UNVERIFIED_TRANSACTION_LIMIT`
 * is enforced in `checkTransactionAllowed()` and consumed by transfers,
 * payments and bills, but no spec had ever crossed it — the payments and
 * transfers specs deliberately stay under $1,000 so they test one rule at a
 * time. So the gate is walked end to end here: refused, wizard, allowed.
 */

/** Mirrors UNVERIFIED_TRANSACTION_LIMIT in backend/src/features/compliance/kyb/kyb.config.ts. */
const UNVERIFIED_TRANSACTION_LIMIT = 1000;

/** Well-formed but never issued — ids are text columns, so this is a clean 404 probe. */
const UNKNOWN_ID = "00000000-0000-0000-0000-000000000000";

type KybStatus = "NOT_STARTED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "NEEDS_INFO";

/** Decimal columns come back from Prisma as JSON strings, hence `string | number`. */
interface BusinessProfile {
  id: string;
  legalName: string;
  registrationNumber: string;
  taxCode: string;
  incorporationDate: string;
  businessType: string;
  industry: string;
  registeredAddress: string;
  website: string | null;
  expectedMonthlyVolume: string | number;
}

interface BeneficialOwner {
  id: string;
  fullName: string;
  dateOfBirth: string;
  nationality: string;
  ownershipPct: string | number;
  role: string;
  idNumber: string;
}

interface KybDocument {
  id: string;
  type: "BUSINESS_REGISTRATION" | "OWNER_ID" | "PROOF_OF_ADDRESS" | "OTHER";
  filename: string;
  mimeType: string;
  url: string;
}

interface KybState {
  status: KybStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  businessProfile: BusinessProfile | null;
  beneficialOwners: BeneficialOwner[];
  kybDocuments: KybDocument[];
}

function profilePayload(overrides: Record<string, unknown> = {}) {
  return {
    legalName: `E2E Holdings ${uniqueSuffix()}`,
    registrationNumber: `REG-${uniqueSuffix()}`,
    taxCode: `TAX-${uniqueSuffix()}`,
    incorporationDate: "2015-06-01",
    businessType: "Joint Stock Company",
    industry: "Import/Export",
    registeredAddress: "12 Nguyen Hue, District 1, Ho Chi Minh City",
    website: "https://example.com",
    expectedMonthlyVolume: 25000,
    ...overrides,
  };
}

function ownerPayload(overrides: Record<string, unknown> = {}) {
  return {
    fullName: `Owner ${uniqueSuffix()}`,
    dateOfBirth: "1985-03-12",
    nationality: "Vietnam",
    ownershipPct: 60,
    role: "Director",
    idNumber: `079${uniqueSuffix()}`,
    ...overrides,
  };
}

const SAMPLE_BASE64 = "SGVsbG8gS1lC";

function documentPayload(
  type: KybDocument["type"] = "BUSINESS_REGISTRATION",
  overrides: Record<string, unknown> = {}
) {
  return {
    type,
    filename: `${type.toLowerCase()}-${uniqueSuffix()}.pdf`,
    mimeType: "application/pdf",
    fileBase64: SAMPLE_BASE64,
    ...overrides,
  };
}

/** Profile + owner + registration document + submit, i.e. the whole happy path. */
async function completeKybWizard(api: ApiClient): Promise<KybState> {
  const profileRes = await api.raw().put("/kyb/profile", profilePayload());
  expect(
    profileRes.status(),
    `PUT /kyb/profile failed: ${await profileRes.text()}`
  ).toBe(200);

  await api.post("/kyb/owners", ownerPayload());
  await api.post("/kyb/documents", documentPayload("BUSINESS_REGISTRATION"));
  return api.post<KybState>("/kyb/submit");
}

/**
 * Two companies nobody else can see, the payer funded. The `sandbox` fixture
 * builds the same thing worker-scoped, but its KYB must stay NOT_STARTED for
 * every other spec in the worker — these tests approve the payer, so they
 * need their own throwaway world.
 */
interface FundedPair {
  payer: ApiClient;
  payerAccount: Account;
  payee: ApiClient;
  payeeAccount: Account;
  dispose(): Promise<void>;
}

async function freshFundedPair(openingBalance: number): Promise<FundedPair> {
  const [payer, payee] = await Promise.all([
    ApiClient.registerNewCompany(),
    ApiClient.registerNewCompany(),
  ]);

  const payerAccount = await payer.client.firstAccount("USD");
  await payer.client.post(`/accounts/${payerAccount.id}/deposit`, { amount: openingBalance });

  return {
    payer: payer.client,
    payerAccount,
    payee: payee.client,
    payeeAccount: await payee.client.firstAccount("USD"),
    async dispose() {
      await payer.client.dispose();
      await payee.client.dispose();
    },
  };
}

async function balanceOf(api: ApiClient, accountId: string): Promise<number> {
  const account = (await api.listAccounts()).find((a) => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} disappeared mid-test`);
  return Number(account.balance);
}

test.describe("GET /api/kyb", () => {
  test("a freshly registered company starts the wizard empty", async ({ outsiderApi }) => {
    const state = await outsiderApi.get<KybState>("/kyb");

    expect(state.status, "registration must not pre-verify anybody").toBe("NOT_STARTED");
    expect(state.businessProfile).toBeNull();
    expect(state.beneficialOwners).toEqual([]);
    expect(state.kybDocuments).toEqual([]);
    expect(state.submittedAt).toBeNull();
    expect(state.reviewedAt).toBeNull();
    expect(state.rejectionReason).toBeNull();
  });
});

test.describe("The wizard", () => {
  test("PUT /kyb/profile stores the profile and shows it in the state", async ({
    outsiderApi,
  }) => {
    const payload = profilePayload();
    const res = await outsiderApi.raw().put("/kyb/profile", payload);
    expect(res.status(), `PUT /kyb/profile: ${await res.text()}`).toBe(200);

    const { businessProfile } = (await res.json()) as { businessProfile: BusinessProfile };
    expect(businessProfile.legalName).toBe(payload.legalName);
    expect(Number(businessProfile.expectedMonthlyVolume)).toBe(payload.expectedMonthlyVolume);

    const state = await outsiderApi.get<KybState>("/kyb");
    expect(state.businessProfile?.registrationNumber).toBe(payload.registrationNumber);
    expect(state.status, "filling in the profile does not submit anything").toBe("NOT_STARTED");
  });

  test("PUT /kyb/profile upserts rather than creating a second profile", async ({
    outsiderApi,
  }) => {
    await outsiderApi.raw().put("/kyb/profile", profilePayload());
    const second = profilePayload({ legalName: "Renamed Holdings Ltd" });
    await outsiderApi.raw().put("/kyb/profile", second);

    const state = await outsiderApi.get<KybState>("/kyb");
    expect(state.businessProfile?.legalName, "the second PUT replaces the first").toBe(
      "Renamed Holdings Ltd"
    );
  });

  test("an empty website is accepted where a malformed one is not", async ({
    outsiderApi,
  }) => {
    // The schema is `.url().optional().or(z.literal(""))` — the empty string
    // is a deliberate escape hatch for a company with no website, and the
    // service normalises it to null rather than storing "".
    const res = await outsiderApi.raw().put("/kyb/profile", profilePayload({ website: "" }));
    expect(res.status(), `an empty website must be allowed: ${await res.text()}`).toBe(200);

    const state = await outsiderApi.get<KybState>("/kyb");
    expect(state.businessProfile?.website).toBeNull();
  });

  test("POST /kyb/owners returns 201 and the owner appears in the state", async ({
    outsiderApi,
  }) => {
    const payload = ownerPayload();
    const res = await outsiderApi.raw().post("/kyb/owners", payload);
    expect(res.status(), `POST /kyb/owners: ${await res.text()}`).toBe(201);

    const { beneficialOwner } = (await res.json()) as { beneficialOwner: BeneficialOwner };
    expect(beneficialOwner.fullName).toBe(payload.fullName);
    expect(Number(beneficialOwner.ownershipPct)).toBe(payload.ownershipPct);

    const state = await outsiderApi.get<KybState>("/kyb");
    expect(state.beneficialOwners.map((o) => o.id)).toContain(beneficialOwner.id);
  });

  test("DELETE /kyb/owners/:id removes the owner", async ({ outsiderApi }) => {
    const { beneficialOwner } = await outsiderApi.post<{ beneficialOwner: BeneficialOwner }>(
      "/kyb/owners",
      ownerPayload()
    );

    const res = await outsiderApi.raw().delete(`/kyb/owners/${beneficialOwner.id}`);
    expect(res.status()).toBe(204);

    const state = await outsiderApi.get<KybState>("/kyb");
    expect(state.beneficialOwners.some((o) => o.id === beneficialOwner.id)).toBe(false);
  });

  test("DELETE /kyb/owners/:id answers 404 for an id this company never had", async ({
    outsiderApi,
  }) => {
    const res = await outsiderApi.raw().delete(`/kyb/owners/${UNKNOWN_ID}`);
    expect(res.status(), "the lookup is company-scoped, so an unknown id is Not Found").toBe(404);
  });

  test("POST /kyb/documents stores the upload as a base64 data URL", async ({ outsiderApi }) => {
    const payload = documentPayload("PROOF_OF_ADDRESS");
    const res = await outsiderApi.raw().post("/kyb/documents", payload);
    expect(res.status(), `POST /kyb/documents: ${await res.text()}`).toBe(201);

    const { kybDocument } = (await res.json()) as { kybDocument: KybDocument };
    expect(kybDocument.type).toBe("PROOF_OF_ADDRESS");
    // The service never persists the raw bytes — it stitches a data URL out of
    // the mime type and the base64 body, which is what the frontend renders.
    expect(kybDocument.url).toBe(`data:${payload.mimeType};base64,${payload.fileBase64}`);
  });

  test("DELETE /kyb/documents/:id removes the document", async ({ outsiderApi }) => {
    const { kybDocument } = await outsiderApi.post<{ kybDocument: KybDocument }>(
      "/kyb/documents",
      documentPayload("OTHER")
    );

    const res = await outsiderApi.raw().delete(`/kyb/documents/${kybDocument.id}`);
    expect(res.status()).toBe(204);

    const state = await outsiderApi.get<KybState>("/kyb");
    expect(state.kybDocuments.some((d) => d.id === kybDocument.id)).toBe(false);
  });

  test("DELETE /kyb/documents/:id answers 404 for an unknown id", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().delete(`/kyb/documents/${UNKNOWN_ID}`);
    expect(res.status()).toBe(404);
  });
});

test.describe("Validation", () => {
  test("the profile rejects a body with fields missing", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().put("/kyb/profile", { legalName: "Only a name" });
    expect(res.status(), "zod failures surface as ValidationError → 400").toBe(400);

    const body = (await res.json()) as { error: string; details?: unknown };
    expect(body.error).toBe("Invalid request body");
    expect(body.details, "the flattened zod issues are handed back to the client").toBeTruthy();
  });

  test("the profile rejects a malformed website", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().put("/kyb/profile",
      profilePayload({ website: "definitely not a url" })
    );
    expect(res.status()).toBe(400);
  });

  test("the profile rejects a negative expected volume", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().put("/kyb/profile",
      profilePayload({ expectedMonthlyVolume: -1 })
    );
    expect(res.status()).toBe(400);
  });

  test("an owner holding more than 100% is rejected", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().post("/kyb/owners", ownerPayload({ ownershipPct: 150 }));
    expect(res.status(), "ownershipPct is capped at 100 by the schema").toBe(400);
  });

  test("an owner with no name is rejected", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().post("/kyb/owners", ownerPayload({ fullName: "" }));
    expect(res.status()).toBe(400);
  });

  test("an owner with an unparseable date of birth is rejected", async ({ outsiderApi }) => {
    const res = await outsiderApi
      .raw()
      .post("/kyb/owners", ownerPayload({ dateOfBirth: "not a date" }));
    expect(res.status()).toBe(400);
  });

  test("a document of an unknown type is rejected", async ({ outsiderApi }) => {
    const res = await outsiderApi
      .raw()
      .post("/kyb/documents", { ...documentPayload(), type: "PASSPORT_SCAN" });
    expect(res.status(), "type is an enum of the four KYB_DOCUMENT_TYPES").toBe(400);
  });

  test("a document with no file body is rejected", async ({ outsiderApi }) => {
    const res = await outsiderApi
      .raw()
      .post("/kyb/documents", { ...documentPayload(), fileBase64: "" });
    expect(res.status()).toBe(400);
  });
});

test.describe("POST /api/kyb/submit", () => {
  test("refuses a company with no business profile", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().post("/kyb/submit", {});
    expect(res.status(), "an incomplete submission is a 422, not a 400").toBe(422);
    expect((await res.json()).error).toMatch(/business profile/i);
  });

  test("refuses a company with a profile but no beneficial owner", async ({
    outsiderApi,
  }) => {
    await outsiderApi.raw().put("/kyb/profile", profilePayload());
    await outsiderApi.post("/kyb/documents", documentPayload("BUSINESS_REGISTRATION"));

    const res = await outsiderApi.raw().post("/kyb/submit", {});
    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/beneficial owner/i);
  });

  test("refuses a company whose documents include no BUSINESS_REGISTRATION", async ({
    outsiderApi,
  }) => {
    await outsiderApi.raw().put("/kyb/profile", profilePayload());
    await outsiderApi.post("/kyb/owners", ownerPayload());
    // Deliberately the wrong type: the check is for a registration document
    // specifically, not for "any document at all".
    await outsiderApi.post("/kyb/documents", documentPayload("OWNER_ID"));

    const res = await outsiderApi.raw().post("/kyb/submit", {});
    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/registration document/i);
  });

  test("approves the company once profile, owner and registration are all present", async ({
    outsiderApi,
  }) => {
    const state = await completeKybWizard(outsiderApi);

    // submitKyb() writes APPROVED itself rather than PENDING_REVIEW: this
    // build has no underwriting team, and the onboarding wizard would strand
    // every new signup if it waited for one.
    expect(state.status, "submit auto-approves in this sandbox build").toBe("APPROVED");
    expect(state.submittedAt).not.toBeNull();
    expect(state.reviewedAt, "auto-approval stamps the review time too").not.toBeNull();
    expect(state.rejectionReason).toBeNull();
  });

  test("a second submit is idempotent rather than an error", async ({ outsiderApi }) => {
    await completeKybWizard(outsiderApi);

    // A double click, or a retry after a later onboarding step failed, must
    // not strand an already-approved company on the review screen.
    const res = await outsiderApi.raw().post("/kyb/submit", {});
    expect(res.status()).toBe(200);
    expect(((await res.json()) as KybState).status).toBe("APPROVED");
  });
});

test.describe("Edits after approval", () => {
  test("every mutating route is refused once the status is locked", async ({
    outsiderApi,
  }) => {
    await completeKybWizard(outsiderApi);

    const profileRes = await outsiderApi.raw().put("/kyb/profile", profilePayload());
    expect(profileRes.status(), "assertEditable() blocks a profile edit after approval").toBe(422);
    expect((await profileRes.json()).error).toMatch(/already verified/i);

    const ownerRes = await outsiderApi.raw().post("/kyb/owners", ownerPayload());
    expect(ownerRes.status(), "no new owners after approval").toBe(422);

    const documentRes = await outsiderApi.raw().post("/kyb/documents", documentPayload("OTHER"));
    expect(documentRes.status(), "no new documents after approval").toBe(422);
  });

  test("an owner submitted as part of the approved pack cannot be deleted", async ({
    outsiderApi,
  }) => {
    await completeKybWizard(outsiderApi);
    const state = await outsiderApi.get<KybState>("/kyb");
    const owner = state.beneficialOwners[0];
    expect(owner, "the wizard left an owner behind to delete").toBeTruthy();

    const res = await outsiderApi.raw().delete(`/kyb/owners/${owner.id}`);
    expect(res.status(), "the ownership pack an approval was granted on is frozen").toBe(422);

    const after = await outsiderApi.get<KybState>("/kyb");
    expect(after.beneficialOwners.some((o) => o.id === owner.id)).toBe(true);
  });
});

test.describe("Authentication", () => {
  test("every /kyb route refuses an anonymous caller", async ({ anonApi }) => {
    const attempts: Array<[string, () => Promise<APIResponse>]> = [
      ["GET /kyb", () => anonApi.raw().get("/kyb")],
      ["PUT /kyb/profile", () => anonApi.raw().put("/kyb/profile", profilePayload())],
      ["POST /kyb/owners", () => anonApi.raw().post("/kyb/owners", ownerPayload())],
      ["DELETE /kyb/owners/:id", () => anonApi.raw().delete(`/kyb/owners/${UNKNOWN_ID}`)],
      ["POST /kyb/documents", () => anonApi.raw().post("/kyb/documents", documentPayload())],
      ["DELETE /kyb/documents/:id", () => anonApi.raw().delete(`/kyb/documents/${UNKNOWN_ID}`)],
      ["POST /kyb/submit", () => anonApi.raw().post("/kyb/submit", {})],
    ];

    for (const [name, call] of attempts) {
      const res = await call();
      expect(res.status(), `${name} is missing requireAuth`).toBe(401);
    }
  });
});

/**
 * The reason KYB exists as far as the rest of the app is concerned.
 *
 * `checkTransactionAllowed()` is called by transfers, payments and bills, but
 * every existing money spec stays under the ceiling on purpose, so nothing
 * proved that finishing the wizard actually lifts it. These two tests own
 * that claim.
 */
test.describe("The unverified transaction limit", () => {
  test("refuses a transfer over the limit, then allows the same one once approved", async ({ }) => {
    const world = await freshFundedPair(5_000);
    try {
      const amount = UNVERIFIED_TRANSACTION_LIMIT + 500;
      const attemptTransfer = () =>
        world.payer.raw().post("/transfers", {
          fromAccountId: world.payerAccount.id,
          toAccountNumber: world.payeeAccount.accountNumber,
          amount,
          note: `kyb gate ${uniqueSuffix()}`,
          otp: DEMO_OTP,
        });

      const before = await balanceOf(world.payer, world.payerAccount.id);

      const blocked = await attemptTransfer();
      expect(
        blocked.status(),
        `an unverified company must not move $${amount}: got ${await blocked.text()}`
      ).toBe(403);
      expect(((await blocked.json()) as { error: string }).error).toMatch(
        /business verification/i
      );
      expect(
        await balanceOf(world.payer, world.payerAccount.id),
        "a refused transfer must leave the balance exactly where it was"
      ).toBeCloseTo(before, 2);

      const state = await completeKybWizard(world.payer);
      expect(state.status, "the wizard must actually approve before the retry means anything").toBe(
        "APPROVED"
      );

      const allowed = await attemptTransfer();
      expect(
        allowed.status(),
        `the identical transfer must now succeed: got ${await allowed.text()}`
      ).toBe(201);
      expect(await balanceOf(world.payer, world.payerAccount.id)).toBeCloseTo(
        before - amount,
        2
      );
    } finally {
      await world.dispose();
    }
  });

  test("the ceiling is inclusive — the limit itself passes, a cent more does not", async () => {
    const world = await freshFundedPair(3_000);
    try {
      const send = (amount: number) =>
        world.payer.raw().post("/transfers", {
          fromAccountId: world.payerAccount.id,
          toAccountNumber: world.payeeAccount.accountNumber,
          amount,
          otp: DEMO_OTP,
        });

      // checkTransactionAllowed() short-circuits on `amount <= LIMIT`, so the
      // limit is the largest allowed amount, not the smallest refused one.
      // The over-limit attempt goes first so it can't be confused with an
      // insufficient-balance rejection later in the test.
      const over = await send(UNVERIFIED_TRANSACTION_LIMIT + 0.01);
      expect(over.status(), "one cent over the ceiling is already over it").toBe(403);

      const exact = await send(UNVERIFIED_TRANSACTION_LIMIT);
      expect(
        exact.status(),
        `exactly the limit must be allowed unverified: ${await exact.text()}`
      ).toBe(201);
    } finally {
      await world.dispose();
    }
  });
});
