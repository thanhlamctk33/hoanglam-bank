/**
 * Base class for all "expected" errors that a route/service throws on
 * purpose (bad input, missing record, not allowed, etc). The central error
 * middleware (see ../middleware/errorHandler.ts) catches these and turns
 * them into the right HTTP response — callers just `throw`, they never
 * touch `res` directly.
 *
 * Anything thrown that is NOT an AppError is treated as a bug (500,
 * generic "Internal server error" body, full stack logged server-side).
 */
export class AppError extends Error {
  public readonly statusCode: number;
  /** Extra JSON-serializable detail merged into the error response (e.g. zod's flatten()). */
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: unknown) {
    super(400, message, details);
  }
}

/** Convenience for zod validation failures: `throw new ValidationError(parsed.error)`. */
export class ValidationError extends AppError {
  constructor(zodError: { flatten: () => unknown }, message = "Invalid request body") {
    super(400, message, zodError.flatten());
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(409, message);
  }
}

/** Business-rule/semantic validation failure — request is well-formed but not allowed given current state. */
export class UnprocessableEntityError extends AppError {
  constructor(message = "Unprocessable entity") {
    super(422, message);
  }
}

/** Plan/usage limit reached (e.g. subscription tier cap). */
export class PaymentRequiredError extends AppError {
  constructor(message = "Payment required") {
    super(402, message);
  }
}

/** Upstream/third-party dependency (AI assistant, OCR, etc) failed or was unreachable. */
export class BadGatewayError extends AppError {
  constructor(message = "Bad gateway") {
    super(502, message);
  }
}

/** A feature is deployed but not usable right now (e.g. missing API key config). */
export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable") {
    super(503, message);
  }
}

/** Account/resource frozen or otherwise locked (matches prior `423` usages). */
export class LockedError extends AppError {
  constructor(message = "Locked") {
    super(423, message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests") {
    super(429, message);
  }
}
