import { test, expect } from "../../fixtures/test";
import { DEMO_USER } from "../../utils/env";

/**
 * Rate limiting — asserted through the RateLimit headers rather than by
 * actually exhausting a bucket.
 *
 * Draining the auth bucket on purpose would leave every auth spec that runs
 * after it staring at 429s for the next fifteen minutes, and the bucket is
 * keyed by IP so no amount of test isolation would undo that. The draft-7
 * headers express-rate-limit emits carry the same information without firing
 * a single wasted request: `RateLimit-Policy: <limit>;w=<seconds>` says which
 * bucket answered, and `RateLimit: limit=…, remaining=…` proves it is
 * counting rather than merely mounted.
 *
 * The ceilings themselves are env-tunable (AUTH_RATE_LIMIT_MAX and friends;
 * playwright.config.ts raises them for the suite) so nothing here asserts a
 * specific number — only the shape and the tiering, which are the parts the
 * design actually promises.
 */

/** Parses `RateLimit-Policy: 300;w=60` into its two numbers. */
function parsePolicy(header: string | undefined): { limit: number; windowSeconds: number } {
  expect(header, "RateLimit-Policy header is present").toBeTruthy();
  const match = /^(\d+);w=(\d+)$/.exec(header!.trim());
  expect(match, `RateLimit-Policy is draft-7 shaped, got "${header}"`).toBeTruthy();
  return { limit: Number(match![1]), windowSeconds: Number(match![2]) };
}

test.describe("Rate limit headers", () => {
  test("an authenticated read is counted by the general limiter", async ({ adminApi }) => {
    const res = await adminApi.raw().get("/accounts");
    expect(res.status()).toBe(200);

    const headers = res.headers();
    const policy = parsePolicy(headers["ratelimit-policy"]);
    expect(policy.windowSeconds, "the general bucket is a one-minute window").toBe(60);

    // Not just mounted — actually tracking this caller.
    const remaining = /remaining=(\d+)/.exec(headers["ratelimit"] ?? "");
    expect(remaining, `RateLimit header is present, got "${headers["ratelimit"]}"`).toBeTruthy();
    expect(Number(remaining![1])).toBeLessThan(policy.limit);
  });

  test("the health probe sits above the limiter", async ({ anonApi }) => {
    // index.ts mounts GET /api/health before app.use("/api", generalLimiter)
    // precisely so uptime checks can hammer it without being throttled. If
    // that ordering is ever shuffled, this catches it.
    const res = await anonApi.raw().get("/health");

    expect(res.status()).toBe(200);
    expect(res.headers()["ratelimit-policy"], "/api/health must not be rate limited").toBeUndefined();
  });

  test("auth has its own, much longer bucket than everything else", async ({ anonApi }) => {
    // A *successful* login on purpose: authLimiter sets skipSuccessfulRequests,
    // so this reads the policy without spending an attempt from the bucket.
    const login = await anonApi.raw().post("/auth/login", DEMO_USER);
    expect(login.status()).toBe(200);

    const authPolicy = parsePolicy(login.headers()["ratelimit-policy"]);
    expect(authPolicy.windowSeconds, "brute-force attempts are counted over 15 minutes").toBe(
      15 * 60
    );

    // /api/auth passes through the general limiter first and its own second,
    // so seeing the auth window here is what proves authLimiter is mounted on
    // the prefix rather than every route sharing one bucket.
    const general = await anonApi.raw().get("/definitely-not-a-route");
    expect(parsePolicy(general.headers()["ratelimit-policy"]).windowSeconds).toBe(60);
  });
});
