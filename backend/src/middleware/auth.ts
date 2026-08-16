import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../features/auth/jwt.service";
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

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(new UnauthorizedError("Missing authorization header"));
  }

  const token = header.slice("Bearer ".length);
  try {
    const payload = verifyToken(token);
    const authedReq = req as AuthedRequest;
    authedReq.userId = payload.userId;
    authedReq.companyId = payload.companyId;
    next();
  } catch {
    next(new UnauthorizedError("Invalid or expired token"));
  }
}
