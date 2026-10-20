import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env";
import { TooManyRequestsError } from "../errors/AppError";

/**
 * Rate limiters, tiered by how damaging abuse of the endpoint would be.
 *
 * All three hand off to the central error handler by passing a
 * TooManyRequestsError to `next` instead of writing their own response, so a
 * throttled request comes back in the same `{ error: "..." }` shape as every
 * other error in the app.
 */
const handler = (message: string) => (_req: unknown, _res: unknown, next: (err: Error) => void) => {
  next(new TooManyRequestsError(message));
};

/**
 * Login/register — the endpoints worth brute-forcing, since a hit yields a
 * valid token. Deliberately the tightest bucket, and counts only failures so
 * a legitimate user who logs in repeatedly isn't punished.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: handler("Too many login attempts. Try again in a few minutes."),
});

/**
 * Public developer API (/api/v1) — authenticated by a long-lived API key
 * rather than a session, so it's the surface most likely to be hammered by a
 * misconfigured integration. Keyed by API key when present so one noisy
 * customer can't exhaust another's quota via a shared IP. The IP fallback goes
 * through ipKeyGenerator so an IPv6 client can't dodge the limit by rotating
 * addresses within its /64.
 */
export const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.PUBLIC_API_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.header("x-api-key") ?? ipKeyGenerator(req.ip ?? "unknown"),
  handler: handler("API rate limit exceeded. Slow down and retry shortly."),
});

/**
 * Everything else — a wide backstop against runaway clients, set high enough
 * that normal dashboard use (which fans out into many parallel requests per
 * page) never trips it.
 */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.GENERAL_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: handler("Too many requests. Slow down and retry shortly."),
});
