import { Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest } from "./auth";
import { asyncHandler } from "./errorHandler";
import { ForbiddenError, UnauthorizedError } from "../errors/AppError";

/**
 * Allows either bank staff (isStaff) or a company's own ADMIN-role user through.
 * Unlike requireStaff, this is meant to be combined with company-scoped queries
 * (req.companyId) so an admin can only act on their own company's data.
 */
export const requireCompanyAdmin = asyncHandler<AuthedRequest>(async (req: AuthedRequest, _res: Response, next: NextFunction) => {
  if (!req.userId) {
    throw new UnauthorizedError("Missing authorization header");
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || (user.role !== "ADMIN" && !user.isStaff)) {
    throw new ForbiddenError("Admin access required");
  }

  next();
});

export function hasApprovalPower(user: { role: string; isStaff: boolean } | null | undefined): boolean {
  return !!user && (user.role === "ADMIN" || user.isStaff);
}
