import { Response, NextFunction, Request } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "./errorHandler";
import { UnauthorizedError } from "../errors/AppError";

// companyId/apiKeyId are guaranteed present on any request that made it past
// requireApiKey below — public API routes are registered as
// `asyncHandler<ApiKeyedRequest>`, which casts the incoming Request to this
// type, so handlers don't need non-null assertions to read them.
export interface ApiKeyedRequest extends Request {
  companyId: string;
  apiKeyId: string;
}

// Auth for the public developer API (/api/v1/*) — a company's own API key in
// the `x-api-key` header, instead of the JWT bearer token the rest of the
// app uses. Deliberately separate from requireAuth: this is what a
// third-party integration calls server-to-server, not a logged-in user.
export const requireApiKey = asyncHandler<Request>(async (req: Request, _res: Response, next: NextFunction) => {
  const key = req.header("x-api-key");
  if (!key) {
    throw new UnauthorizedError("Missing x-api-key header");
  }

  const apiKey = await prisma.apiKey.findUnique({ where: { key } });
  if (!apiKey || apiKey.revokedAt) {
    throw new UnauthorizedError("Invalid or revoked API key");
  }

  const keyedReq = req as ApiKeyedRequest;
  keyedReq.companyId = apiKey.companyId;
  keyedReq.apiKeyId = apiKey.id;
  await prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
  next();
});
