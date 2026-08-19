import { describe, expect, it, vi, beforeEach } from "vitest";

// requireAuth reads the user's current tokenVersion straight from the
// repository, so that's the only thing worth mocking — the JWT itself is
// signed and verified for real, which is what makes these tests meaningful.
vi.mock("../features/platform/auth/auth.repository", () => ({
  findUserTokenVersion: vi.fn(),
}));

// requireAuth pulls in asyncHandler, which pulls in the pino logger, which
// reads env at import time — so the mock has to cover the logger's fields too,
// not just the JWT secret.
vi.mock("../config/env", () => ({
  env: { JWT_SECRET: "test-secret-at-least-16-chars", LOG_LEVEL: "silent", NODE_ENV: "test" },
  isProduction: false,
}));

import { requireAuth } from "./auth";
import { signToken } from "../features/platform/auth/jwt.service";
import { findUserTokenVersion } from "../features/platform/auth/auth.repository";
import { UnauthorizedError } from "../errors/AppError";

beforeEach(() => {
  vi.clearAllMocks();
});

/** Runs requireAuth against a fake request and reports what it did. */
async function runRequireAuth(authorizationHeader?: string) {
  const req = { headers: authorizationHeader ? { authorization: authorizationHeader } : {} } as never;
  const next = vi.fn();

  await (requireAuth as unknown as (req: unknown, res: unknown, next: unknown) => Promise<void>)(req, {}, next);

  const error = next.mock.calls[0]?.[0];
  return { req: req as { userId?: string; companyId?: string }, error, allowed: next.mock.calls.length > 0 && !error };
}

const validToken = (tokenVersion: number) => signToken({ userId: "user-1", companyId: "company-1", tokenVersion });

describe("requireAuth — token shape", () => {
  it("rejects a request with no authorization header", async () => {
    const { error, allowed } = await runRequireAuth();

    expect(allowed).toBe(false);
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(findUserTokenVersion).not.toHaveBeenCalled();
  });

  it("rejects an authorization header that isn't a Bearer token", async () => {
    const { error } = await runRequireAuth("Basic dXNlcjpwYXNz");

    expect(error).toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a token that wasn't signed with our secret", async () => {
    const { error } = await runRequireAuth("Bearer not.a.real.token");

    expect(error).toBeInstanceOf(UnauthorizedError);
    // A forged token must never reach the database lookup.
    expect(findUserTokenVersion).not.toHaveBeenCalled();
  });
});

describe("requireAuth — revocation", () => {
  it("allows a token whose version still matches the user's", async () => {
    vi.mocked(findUserTokenVersion).mockResolvedValue({ tokenVersion: 3 } as never);

    const { req, allowed } = await runRequireAuth(`Bearer ${validToken(3)}`);

    expect(allowed).toBe(true);
    expect(req.userId).toBe("user-1");
    expect(req.companyId).toBe("company-1");
  });

  it("rejects a token issued before a sign-out-everywhere", async () => {
    // The signature is still valid — this is exactly the case a signature
    // check alone cannot catch, and the reason for the database read.
    const tokenFromOldSession = validToken(3);
    vi.mocked(findUserTokenVersion).mockResolvedValue({ tokenVersion: 4 } as never);

    const { error, allowed } = await runRequireAuth(`Bearer ${tokenFromOldSession}`);

    expect(allowed).toBe(false);
    expect(error).toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a token minted before tokenVersion existed", async () => {
    // Older tokens carry no tokenVersion at all, which decodes as undefined
    // and must not be treated as matching version 0.
    const legacyToken = signToken({ userId: "user-1", companyId: "company-1" } as never);
    vi.mocked(findUserTokenVersion).mockResolvedValue({ tokenVersion: 0 } as never);

    const { error } = await runRequireAuth(`Bearer ${legacyToken}`);

    expect(error).toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a token for a user who no longer exists", async () => {
    vi.mocked(findUserTokenVersion).mockResolvedValue(null as never);

    const { error } = await runRequireAuth(`Bearer ${validToken(0)}`);

    expect(error).toBeInstanceOf(UnauthorizedError);
  });

  it("checks the version against the user named in the token", async () => {
    vi.mocked(findUserTokenVersion).mockResolvedValue({ tokenVersion: 0 } as never);

    await runRequireAuth(`Bearer ${validToken(0)}`);

    expect(findUserTokenVersion).toHaveBeenCalledWith("user-1");
  });
});
