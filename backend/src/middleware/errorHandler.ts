import { NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "../lib/logger";
import { AppError } from "../errors/AppError";

/**
 * Wrap an async route handler so a rejected promise reaches `errorHandler`
 * below instead of becoming an unhandled rejection (Express 4 does not do
 * this automatically for `async (req, res) => {...}` handlers). Every
 * feature route should be registered as `asyncHandler(async (req, res) => {
 * ... throw new NotFoundError(...) ... })` instead of manually catching and
 * mapping errors to `res.status(...).json(...)` itself.
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as Req, res, next)).catch(next);
  };
}

/**
 * Central error-handling middleware. Routes/services throw an AppError (or
 * subclass — see ../errors/AppError.ts) for any expected failure; this is
 * the single place that turns that into an HTTP response, so route
 * handlers never call `res.status(...).json({ error: ... })` themselves.
 * Anything that isn't an AppError is treated as a bug: logged with full
 * detail, reported to the client as a generic 500.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) {
    return;
  }

  if (err instanceof AppError) {
    const body: { error: string; details?: unknown } = { error: err.message };
    if (err.details !== undefined) body.details = err.details;
    return res.status(err.statusCode).json(body);
  }

  logger.error({ err, path: req.path }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
}
