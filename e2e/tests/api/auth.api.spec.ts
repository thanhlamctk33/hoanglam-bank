import { test, expect } from "../../fixtures/test";
import { ApiClient } from "../../utils/api-client";
import { DEMO_OTP, DEMO_USER } from "../../utils/env";
import { newUserPayload, uniqueEmail } from "../../utils/data";

/**
 * Contract tests for /api/auth. No browser involved — these keep working (and
 * keep being informative) even when the frontend is mid-refactor.
 *
 * Everything here is deliberately driven through `anonApi` (a client with no
 * token): registering and logging in are the two things an unauthenticated
 * caller is *supposed* to be able to do, so the anonymous client is the
 * honest way to exercise them.
 */

test.describe("GET /api/health", () => {
  test("reports ok", async ({ anonApi }) => {
    const res = await anonApi.raw().get("/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

test.describe("POST /api/auth/login", () => {
  test("returns a token, user and company for valid credentials", async ({ anonApi }) => {
    const res = await anonApi.raw().post("/auth/login", DEMO_USER);

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.token).toEqual(expect.any(String));
    expect(body.user.email).toBe(DEMO_USER.email);
    expect(body.company.id).toEqual(expect.any(String));
    // The hash must never leave the server.
    expect(JSON.stringify(body)).not.toMatch(/passwordHash/);
  });

  test("rejects a bad password with 401 and a generic message", async ({ anonApi }) => {
    const res = await anonApi.raw().post("/auth/login", {
      email: DEMO_USER.email,
      password: "wrong-password",
    });

    expect(res.status()).toBe(401);
    // Deliberately generic: it must not reveal whether the email exists.
    expect((await res.json()).error).toMatch(/invalid email or password/i);
  });

  test("rejects an unknown email with the same 401", async ({ anonApi }) => {
    const res = await anonApi.raw().post("/auth/login", {
      email: uniqueEmail("nobody"),
      password: "whatever123",
    });

    expect(res.status()).toBe(401);
    expect((await res.json()).error).toMatch(/invalid email or password/i);
  });

  test("rejects a malformed body with 400/422", async ({ anonApi }) => {
    const res = await anonApi.raw().post("/auth/login", { email: "not-an-email", password: "" });

    expect([400, 422]).toContain(res.status());
  });
});

test.describe("POST /api/auth/register", () => {
  test("creates a company, an owner and a primary USD account", async ({ anonApi }) => {
    const payload = newUserPayload(DEMO_OTP);

    const res = await anonApi.raw().post("/auth/register", payload);
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.user.email).toBe(payload.email);
    expect(body.company.name).toBe(payload.companyName);

    // Every new company is seeded with one cash account.
    const owner = await ApiClient.create(body.token);
    try {
      const accounts = await owner.listAccounts();
      expect(accounts.length).toBeGreaterThanOrEqual(1);
      expect(accounts[0].currency).toBe("USD");
    } finally {
      await owner.dispose();
    }
  });

  test("rejects a duplicate email with 409", async ({ anonApi }) => {
    const res = await anonApi
      .raw()
      .post("/auth/register", { ...newUserPayload(DEMO_OTP), email: DEMO_USER.email });

    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/already registered/i);
  });

  test("rejects a wrong OTP with 422", async ({ anonApi }) => {
    const res = await anonApi.raw().post("/auth/register", newUserPayload("0000"));

    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/invalid otp/i);
  });

  test("rejects a password shorter than 8 characters", async ({ anonApi }) => {
    const res = await anonApi
      .raw()
      .post("/auth/register", { ...newUserPayload(DEMO_OTP), password: "short" });

    expect([400, 422]).toContain(res.status());
  });
});

test.describe("GET /api/auth/me", () => {
  test("returns the caller's identity for a valid token", async ({ adminApi, adminAuth }) => {
    const { user } = await adminApi.get<{ user: { email: string; id: string } }>("/auth/me");

    expect(user.email).toBe(DEMO_USER.email);
    // The identity behind the token is the same one /auth/login handed back.
    expect(user.id).toBe(adminAuth.user.id);
  });

  test("401s without a token", async ({ anonApi }) => {
    const res = await anonApi.raw().get("/auth/me");
    expect(res.status()).toBe(401);
  });

  test("401s on a forged token", async ({ anonApi }) => {
    const forged = await ApiClient.create("not.a.real.jwt");
    try {
      const res = await forged.raw().get("/auth/me");
      expect(res.status()).toBe(401);
    } finally {
      await forged.dispose();
    }
  });
});
