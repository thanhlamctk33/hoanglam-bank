import "dotenv/config";
import { z } from "zod";

/**
 * Single source of truth for every environment variable the backend reads.
 *
 * Validated once at import time so a misconfigured deployment fails
 * immediately with a readable message, instead of failing later at the first
 * request that happens to need the missing value. Nothing else in the
 * codebase should touch `process.env` directly — import `env` from here.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required (set it in backend/.env)"),

  // Signs every auth token. A weak/default secret in production would let
  // anyone mint a valid token for any company, so the length floor and the
  // production-only check below are deliberate.
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),

  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  // Optional: the AI assistant and receipt OCR degrade gracefully when this
  // isn't set (they return 503 / skip extraction rather than crashing), so
  // it stays optional instead of required.
  ANTHROPIC_API_KEY: z.string().optional(),

  // Rate-limit ceilings (see middleware/rateLimit.ts). The defaults are the
  // production values and apply whenever these are unset, so leaving them
  // out changes nothing.
  //
  // They exist because the e2e suite deliberately drives ~10 *failed* logins
  // per pass (wrong password, unknown email, duplicate email, bad OTP …),
  // which is exactly the AUTH ceiling. Without a way to raise it, a second
  // run inside the 15-minute window — or a single CI retry — starts handing
  // back 429s and a dozen auth tests fail for a reason that has nothing to
  // do with what they assert.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  GENERAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  PUBLIC_API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const issues = parsedEnv.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
  // Intentionally console.error + exit rather than the pino logger: the
  // logger itself reads LOG_LEVEL from here, so it may not be usable yet.
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsedEnv.data;

// Catches the classic "shipped the example .env to prod" mistake, which the
// schema above can't express (the placeholder is long enough to pass min()).
if (env.NODE_ENV === "production" && env.JWT_SECRET === "change-this-dev-secret") {
  console.error("Invalid environment configuration:\n  - JWT_SECRET is still the example value; set a real secret in production");
  process.exit(1);
}

/** True when running the real deployment — used to gate sandbox/demo-only endpoints. */
export const isProduction = env.NODE_ENV === "production";

// Raising the auth ceiling is a test-environment convenience. In production it
// widens the brute-force window, so say so loudly rather than failing startup —
// there are legitimate reasons to tune it, but none that should pass unnoticed.
if (isProduction && env.AUTH_RATE_LIMIT_MAX > 10) {
  console.warn(
    `AUTH_RATE_LIMIT_MAX is ${env.AUTH_RATE_LIMIT_MAX} in production (default 10) — that many failed logins are allowed per IP per 15 minutes.`
  );
}

/** Whether AI-backed features (assistant chat, receipt OCR) are usable. */
export const isAiConfigured = !!env.ANTHROPIC_API_KEY;
