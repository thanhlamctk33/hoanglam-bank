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

/** Registration payload matching backend registerSchema (auth.routes.ts). */
export function newUserPayload(otp: string) {
  return {
    companyName: uniqueCompanyName(),
    name: "E2E Tester",
    email: uniqueEmail(),
    phone: "+1 555 010 0199",
    password: "Password123!",
    otp,
  };
}

/** Small amount that won't drain a seeded balance across a long test run. */
export function smallAmount(): number {
  return Number((1 + Math.random() * 4).toFixed(2));
}
