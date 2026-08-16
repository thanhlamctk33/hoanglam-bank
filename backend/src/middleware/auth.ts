import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../features/auth/jwt.service";
import { UnauthorizedError } from "../errors/AppError";

export interface AuthedRequest extends Request {
  userId?: string;
  companyId?: string;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(new UnauthorizedError("Missing authorization header"));
  }

  const token = header.slice("Bearer ".length);
  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    req.companyId = payload.companyId;
    next();
  } catch {
    next(new UnauthorizedError("Invalid or expired token"));
  }
}
