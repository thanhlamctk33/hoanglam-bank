import type { APIResponse } from "@playwright/test";
import { test, expect } from "../../fixtures/test";
import { ApiClient } from "../../utils/api-client";
import { API_BASE_URL } from "../../utils/env";
import { uniqueEmail, uniqueSuffix } from "../../utils/data";

/**
 * /api/kyc — individual identity verification.
 *
 * The distinction this file is built around: KYC verifies a PERSON, KYB
 * verifies a BUSINESS. Every route here keys off `req.userId`, never
 * `req.companyId`, so two colleagues inside one company have two entirely
 * separate KYC records — the last describe pins that down, because it is the
 * kind of scoping that a well-meaning refactor towards "company compliance
 * state" would quietly break.
 *
 * Like KYB, submit auto-approves (there is no staff review queue for KYC at
 * all), which makes approval a one-way door: `assertEditable()` refuses every
 * further edit. So each mutating test needs a caller whose KYC has never been
 * touched. `outsiderApi` is that caller — a company, and therefore a user,
 * registered for the one test. The seeded demo admin is APPROVED by
 * `prisma/seed.ts` and is only ever read here, never written.
 *
 * One shape note: GET /kyc answers `{ status, profile }` while PUT and POST
 * answer `{ profile }` alone, with the status living on the profile row. The
 * assertions below follow whichever shape the route actually returns.
 */

type KycStatus = "NOT_STARTED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "NEEDS_INFO";

interface KycProfile {
  id: string;
  userId: string;
  fullName: string;
  dateOfBirth: string;
  nationality: string;
  idType: "NATIONAL_ID" | "PASSPORT";
  idNumber: string;
  idDocumentUrl: string | null;
  status: KycStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
}

interface KycState {
  status: KycStatus;
  profile: KycProfile | null;
}

function profilePayload(overrides: Record<string, unknown> = {}) {
  return {
    fullName: `E2E Person ${uniqueSuffix()}`,
    dateOfBirth: "1990-01-01",
    nationality: "Vietnam",
    idType: "NATIONAL_ID",
    idNumber: `079${uniqueSuffix()}`,
    ...overrides,
  };
}

const SAMPLE_BASE64 = "SGVsbG8gS1lD";

function documentPayload(overrides: Record<string, unknown> = {}) {
  return {
    filename: `id-${uniqueSuffix()}.png`,
    mimeType: "image/png",
    fileBase64: SAMPLE_BASE64,
    ...overrides,
  };
}

/** Details + ID photo + submit, i.e. the whole happy path, asserted as it goes. */
async function completeKycWizard(api: ApiClient): Promise<KycProfile> {
  const profileRes = await api.raw().put("/kyc/profile", profilePayload());
  expect(profileRes.status(), `PUT /kyc/profile failed: ${await profileRes.text()}`).toBe(200);

  const documentRes = await api.raw().put("/kyc/document", documentPayload());
  expect(documentRes.status(), `PUT /kyc/document failed: ${await documentRes.text()}`).toBe(200);

  const { profile } = await api.post<{ profile: KycProfile }>("/kyc/submit");
  return profile;
}

test.describe("GET /api/kyc", () => {
  test("a freshly registered user has no identity record at all", async ({ outsiderApi }) => {
    const state = await outsiderApi.get<KycState>("/kyc");

    // No row yet, so the status is synthesised by the service rather than read
    // off a profile — worth asserting both halves.
    expect(state.status, "registration must not pre-verify anybody").toBe("NOT_STARTED");
    expect(state.profile).toBeNull();
  });
});

test.describe("The wizard", () => {
  test("PUT /kyc/profile stores the details and leaves them unverified", async ({
    outsiderApi,
  }) => {
    const payload = profilePayload({ idType: "PASSPORT" });
    const res = await outsiderApi.raw().put("/kyc/profile", payload);
    expect(res.status(), `PUT /kyc/profile: ${await res.text()}`).toBe(200);

    const { profile } = (await res.json()) as { profile: KycProfile };
    expect(profile.fullName).toBe(payload.fullName);
    expect(profile.idType).toBe("PASSPORT");
    expect(profile.status, "filling in details is not submitting them").toBe("NOT_STARTED");
    expect(profile.idDocumentUrl).toBeNull();

    const state = await outsiderApi.get<KycState>("/kyc");
    expect(state.profile?.idNumber).toBe(payload.idNumber);
  });

  test("PUT /kyc/profile upserts rather than creating a second record", async ({
    outsiderApi,
  }) => {
    const first = await outsiderApi.raw().put("/kyc/profile", profilePayload());
    const firstId = ((await first.json()) as { profile: KycProfile }).profile.id;

    const second = await outsiderApi.raw().put("/kyc/profile",
      profilePayload({ fullName: "Renamed Person" })
    );
    const secondProfile = ((await second.json()) as { profile: KycProfile }).profile;

    expect(secondProfile.id, "the same row is updated in place").toBe(firstId);
    expect(secondProfile.fullName).toBe("Renamed Person");
  });

  test("PUT /kyc/document before any details is refused", async ({ outsiderApi }) => {
    // The document is written with an `update`, so there has to be a row to
    // update — the service turns that into a readable 422 instead of letting
    // Prisma throw.
    const res = await outsiderApi.raw().put("/kyc/document", documentPayload());
    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/identity details/i);
  });

  test("PUT /kyc/document stores the upload as a base64 data URL", async ({
    outsiderApi,
  }) => {
    await outsiderApi.raw().put("/kyc/profile", profilePayload());

    const payload = documentPayload();
    const res = await outsiderApi.raw().put("/kyc/document", payload);
    expect(res.status(), `PUT /kyc/document: ${await res.text()}`).toBe(200);

    const { profile } = (await res.json()) as { profile: KycProfile };
    expect(profile.idDocumentUrl).toBe(`data:${payload.mimeType};base64,${payload.fileBase64}`);
    expect(profile.status, "uploading an ID does not submit it either").toBe("NOT_STARTED");
  });

  test("POST /kyc/submit approves once details and an ID photo exist", async ({
    outsiderApi,
  }) => {
    const profile = await completeKycWizard(outsiderApi);

    // There is no staff KYC queue anywhere in the app, so PENDING_REVIEW would
    // be a dead end — submit approves on the spot.
    expect(profile.status, "submit auto-approves in this sandbox build").toBe("APPROVED");
    expect(profile.submittedAt).not.toBeNull();
    expect(profile.reviewedAt, "auto-approval stamps the review time too").not.toBeNull();
    expect(profile.rejectionReason).toBeNull();

    const state = await outsiderApi.get<KycState>("/kyc");
    expect(state.status, "the top-level status mirrors the profile row").toBe("APPROVED");
  });

  test("a second submit is idempotent rather than an error", async ({ outsiderApi }) => {
    await completeKycWizard(outsiderApi);

    const res = await outsiderApi.raw().post("/kyc/submit", {});
    expect(res.status(), "a retried submit must not strand an approved user").toBe(200);
    expect(((await res.json()) as { profile: KycProfile }).profile.status).toBe("APPROVED");
  });
});

test.describe("Submit preconditions", () => {
  test("refuses a user who has filled in nothing", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().post("/kyc/submit", {});
    expect(res.status(), "an incomplete submission is a 422, not a 400").toBe(422);
    expect((await res.json()).error).toMatch(/identity details/i);
  });

  test("refuses a user with details but no ID photo", async ({ outsiderApi }) => {
    await outsiderApi.raw().put("/kyc/profile", profilePayload());

    const res = await outsiderApi.raw().post("/kyc/submit", {});
    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/photo of your id/i);
  });
});

test.describe("Validation", () => {
  test("an unknown idType is rejected", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().put("/kyc/profile",
      profilePayload({ idType: "DRIVERS_LICENSE" })
    );
    expect(res.status(), "idType is an enum of the two KYC_ID_TYPES").toBe(400);

    const body = (await res.json()) as { error: string; details?: unknown };
    expect(body.error).toBe("Invalid request body");
    expect(body.details, "the flattened zod issues are handed back to the client").toBeTruthy();
  });

  test("a body with fields missing is rejected", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().put("/kyc/profile", { fullName: "Only a name" });
    expect(res.status()).toBe(400);
  });

  test("an empty ID number is rejected", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().put("/kyc/profile", profilePayload({ idNumber: "" }));
    expect(res.status()).toBe(400);
  });

  test("an unparseable date of birth is rejected", async ({ outsiderApi }) => {
    const res = await outsiderApi.raw().put("/kyc/profile",
      profilePayload({ dateOfBirth: "not a date" })
    );
    expect(res.status()).toBe(400);
  });

  test("a document with no file body is rejected", async ({ outsiderApi }) => {
    await outsiderApi.raw().put("/kyc/profile", profilePayload());

    const res = await outsiderApi.raw().put("/kyc/document",
      documentPayload({ fileBase64: "" })
    );
    // Schema validation runs before the service, so this is a 400 even though
    // the same route answers 422 when the profile is missing.
    expect(res.status()).toBe(400);
  });
});

test.describe("Edits after approval", () => {
  test("re-filing the details is refused once verified", async ({ outsiderApi }) => {
    await completeKycWizard(outsiderApi);

    const res = await outsiderApi.raw().put("/kyc/profile", profilePayload());
    expect(res.status(), "assertEditable() blocks an edit after approval").toBe(422);
    expect((await res.json()).error).toMatch(/already verified/i);
  });

  test("replacing the ID photo is refused once verified", async ({ outsiderApi }) => {
    await completeKycWizard(outsiderApi);

    const res = await outsiderApi.raw().put("/kyc/document", documentPayload());
    expect(res.status(), "the ID an approval was granted on cannot be swapped out").toBe(422);
  });
});

test.describe("Authentication", () => {
  test("every /kyc route refuses an anonymous caller", async ({ anonApi }) => {
    const attempts: Array<[string, () => Promise<APIResponse>]> = [
      ["GET /kyc", () => anonApi.raw().get("/kyc")],
      ["PUT /kyc/profile", () => anonApi.raw().put("/kyc/profile", profilePayload())],
      ["PUT /kyc/document", () => anonApi.raw().put("/kyc/document", documentPayload())],
      ["POST /kyc/submit", () => anonApi.raw().post("/kyc/submit", {})],
    ];

    for (const [name, call] of attempts) {
      const res = await call();
      expect(res.status(), `${name} is missing requireAuth`).toBe(401);
    }
  });
});

/**
 * KYC is per USER. Everything in kyc.repository.ts keys on `userId`, and the
 * routes read `req.userId` — never `req.companyId` — so verifying the director
 * must not verify their staff, and vice versa. Two tests: one that watches a
 * live approval fail to spread across a company, and one cheap read-only pin
 * on the seeded company.
 */
test.describe("KYC is per user, not per company", () => {
  test("approving the admin's identity leaves their teammate's untouched", async ({
    outsiderApi,
  }) => {
    // A second user inside the SAME company as outsiderApi — the tightest
    // possible probe, since the two callers differ in nothing but userId.
    const teammateCredentials = { email: uniqueEmail("kyc-teammate"), password: "Password123!" };
    await outsiderApi.post("/team", {
      name: "E2E Teammate",
      email: teammateCredentials.email,
      password: teammateCredentials.password,
      role: "MEMBER",
    });

    const { client: teammateApi } = await ApiClient.login(teammateCredentials);
    try {
      const adminProfile = await completeKycWizard(outsiderApi);
      expect(adminProfile.status).toBe("APPROVED");

      const teammateState = await teammateApi.get<KycState>("/kyc");
      expect(
        teammateState.status,
        "the admin's approval must not verify everyone in the company"
      ).toBe("NOT_STARTED");
      expect(teammateState.profile).toBeNull();

      // …and the teammate can still verify themselves, into their own row.
      const teammateProfile = await completeKycWizard(teammateApi);
      expect(teammateProfile.status).toBe("APPROVED");
      expect(teammateProfile.id, "two colleagues hold two distinct KYC records").not.toBe(
        adminProfile.id
      );
      expect(teammateProfile.userId).not.toBe(adminProfile.userId);
    } finally {
      await teammateApi.dispose();
    }
  });

  test("the seeded admin is verified while their MEMBER colleague is not", async ({
    adminApi,
    memberApi,
  }) => {
    // Read-only on purpose: both of these users are shared by the whole suite.
    // seed.ts backfills an APPROVED KycProfile for demo@lambank.dev only, so
    // the seeded company itself is a standing example of the split.
    const adminState = await adminApi.get<KycState>("/kyc");
    const memberState = await memberApi.get<KycState>("/kyc");

    expect(adminState.status, "seed.ts backfills the demo admin's KYC").toBe("APPROVED");
    expect(
      memberState.status,
      "the member shares the admin's company but not their verification"
    ).toBe("NOT_STARTED");
    expect(memberState.profile).toBeNull();
  });
});
