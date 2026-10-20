/** Test-data generators. Everything is unique per run so specs never collide. */

/** Monotonic-ish suffix: timestamp + a short random tail. */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}+${uniqueSuffix()}@lambank.test`;
}

export function uniqueCompanyName(): string {
  return `E2E Co ${uniqueSuffix()}`;
}

/**
 * The password every company registered by this suite is created with.
 * Exported because some routes ask for it again as a confirmation step —
 * PATCH /cards/:id/status and POST /cards/:id/reveal both re-check it — so a
 * spec needs the literal, not just a client that is already signed in.
 */
export const NEW_COMPANY_PASSWORD = "Password123!";

/** Registration payload matching backend registerSchema (auth.routes.ts). */
export function newUserPayload(otp: string) {
  return {
    companyName: uniqueCompanyName(),
    name: "E2E Tester",
    email: uniqueEmail(),
    phone: "+1 555 010 0199",
    password: NEW_COMPANY_PASSWORD,
    otp,
  };
}

/** Small amount that won't drain a seeded balance across a long test run. */
export function smallAmount(): number {
  return Number((1 + Math.random() * 4).toFixed(2));
}
