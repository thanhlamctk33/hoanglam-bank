import { Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest } from "./auth";
import { asyncHandler } from "./errorHandler";
import { ForbiddenError, UnauthorizedError } from "../errors/AppError";

export const requireStaff = asyncHandler<AuthedRequest>(async (req: AuthedRequest, _res: Response, next: NextFunction) => {
  if (!req.userId) {
    throw new UnauthorizedError("Missing authorization header");
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || !user.isStaff) {
    throw new ForbiddenError("Staff access required");
  }

  next();
});
