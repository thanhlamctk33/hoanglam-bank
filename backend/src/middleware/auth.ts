import { Request, Response, NextFunction } from "express";
import { verifyToken, TokenPayload } from "../features/platform/auth/jwt.service";
import { findUserTokenVersion } from "../features/platform/auth/auth.repository";
import { asyncHandler } from "./errorHandler";
import { UnauthorizedError } from "../errors/AppError";

// userId/companyId are guaranteed present on any request that made it past
// requireAuth below — routes are registered as `asyncHandler<AuthedRequest>`,
// which casts the incoming Request to this type. Keeping the fields
// non-optional here means route handlers can use req.userId / req.companyId
// directly instead of the req.userId! / req.companyId! assertions that used
// to be needed everywhere.
export interface AuthedRequest extends Request {
  userId: string;
  companyId: string;
}

/**
 * Rejects the request unless it carries a valid, still-current token.
 *
 * "Still-current" is the part that costs a database read: a signature check
 * alone can only say the token was genuine when it was minted, never that it
 * hasn't been revoked since. Comparing the token's tokenVersion against the
 * user's row is what makes "sign out everywhere" actually cut existing
 * sessions. It's one lookup on a primary key, and requireStaff /
 * requireCompanyAdmin already read the same row on the routes that use them.
 */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(new UnauthorizedError("Missing authorization header"));
  }

  const token = header.slice("Bearer ".length);
  let payload: TokenPayload;
  try {
    payload = verifyToken(token);
  } catch {
    return next(new UnauthorizedError("Invalid or expired token"));
  }

  const user = await findUserTokenVersion(payload.userId);
  if (!user || user.tokenVersion !== payload.tokenVersion) {
    // Either the account is gone, or the token predates a "sign out
    // everywhere" (or predates tokenVersion existing at all, which reads as
    // undefined here). Deliberately worded so it reads as "sign in again"
    // rather than "something is broken".
    return next(new UnauthorizedError("Session expired — please sign in again"));
  }

  const authedReq = req as AuthedRequest;
  authedReq.userId = payload.userId;
  authedReq.companyId = payload.companyId;
  next();
});
