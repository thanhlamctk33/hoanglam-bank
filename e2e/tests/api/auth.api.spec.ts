import { test, expect } from "@playwright/test";
import { ApiClient } from "../../utils/api-client";
import { API_BASE_URL, DEMO_OTP, DEMO_USER } from "../../utils/env";
import { newUserPayload, uniqueEmail } from "../../utils/data";

/**
 * Contract tests for /api/auth. No browser involved — these keep working (and
 * keep being informative) even when the frontend is mid-refactor.
 */

test.describe("GET /api/health", () => {
  test("reports ok", async ({ request }) => {
    const res = await request.get(`${API_BASE_URL}/health`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

test.describe("POST /api/auth/login", () => {
  test("returns a token, user and company for valid credentials", async ({ request }) => {
    const res = await request.post(`${API_BASE_URL}/auth/login`, { data: DEMO_USER });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.token).toEqual(expect.any(String));
    expect(body.user.email).toBe(DEMO_USER.email);
    expect(body.company.id).toEqual(expect.any(String));
    // The hash must never leave the server.
    expect(JSON.stringify(body)).not.toMatch(/passwordHash/);
  });

  test("rejects a bad password with 401 and a generic message", async ({ request }) => {
    const res = await request.post(`${API_BASE_URL}/auth/login`, {
      data: { email: DEMO_USER.email, password: "wrong-password" },
    });

    expect(res.status()).toBe(401);
    // Deliberately generic: it must not reveal whether the email exists.
    expect((await res.json()).error).toMatch(/invalid email or password/i);
  });

  test("rejects an unknown email with the same 401", async ({ request }) => {
    const res = await request.post(`${API_BASE_URL}/auth/login`, {
      data: { email: uniqueEmail("nobody"), password: "whatever123" },
    });

    expect(res.status()).toBe(401);
    expect((await res.json()).error).toMatch(/invalid email or password/i);
  });

  test("rejects a malformed body with 400/422", async ({ request }) => {
    const res = await request.post(`${API_BASE_URL}/auth/login`, {
      data: { email: "not-an-email", password: "" },
    });

    expect([400, 422]).toContain(res.status());
  });
});

test.describe("POST /api/auth/register", () => {
  test("creates a company, an owner and a primary USD account", async ({ request }) => {
    const payload = newUserPayload(DEMO_OTP);

    const res = await request.post(`${API_BASE_URL}/auth/register`, { data: payload });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.user.email).toBe(payload.email);
    expect(body.company.name).toBe(payload.companyName);

    // Every new company is seeded with one cash account.
    const client = new ApiClient(request, body.token);
    const accounts = await client.listAccounts();
    expect(accounts.length).toBeGreaterThanOrEqual(1);
    expect(accounts[0].currency).toBe("USD");
  });

  test("rejects a duplicate email with 409", async ({ request }) => {
    const res = await request.post(`${API_BASE_URL}/auth/register`, {
      data: { ...newUserPayload(DEMO_OTP), email: DEMO_USER.email },
    });

    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/already registered/i);
  });

  test("rejects a wrong OTP with 422", async ({ request }) => {
    const res = await request.post(`${API_BASE_URL}/auth/register`, {
      data: newUserPayload("0000"),
    });

    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/invalid otp/i);
  });

  test("rejects a password shorter than 8 characters", async ({ request }) => {
    const res = await request.post(`${API_BASE_URL}/auth/register`, {
      data: { ...newUserPayload(DEMO_OTP), password: "short" },
    });

    expect([400, 422]).toContain(res.status());
  });
});

test.describe("GET /api/auth/me", () => {
  test("returns the caller's identity for a valid token", async ({ request }) => {
    const login = await request.post(`${API_BASE_URL}/auth/login`, { data: DEMO_USER });
    const { token } = await login.json();

    const res = await request.get(`${API_BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status()).toBe(200);
    expect((await res.json()).user.email).toBe(DEMO_USER.email);
  });

  test("401s without a token", async ({ request }) => {
    const res = await request.get(`${API_BASE_URL}/auth/me`);
    expect(res.status()).toBe(401);
  });

  test("401s on a forged token", async ({ request }) => {
    const res = await request.get(`${API_BASE_URL}/auth/me`, {
      headers: { Authorization: "Bearer not.a.real.jwt" },
    });
    expect(res.status()).toBe(401);
  });
});
