import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
// Imported first so an invalid/missing env var aborts startup before any
// route module (which may read `env`) is even loaded.
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { errorHandler } from "./middleware/errorHandler";
import { authLimiter, generalLimiter, publicApiLimiter } from "./middleware/rateLimit";
// Route modules, grouped the same way src/features is grouped.
// banking — tài khoản và dòng tiền
import accountRoutes from "./features/banking/accounts/accounts.routes";
import accountDemoRoutes from "./features/banking/accounts-demo/accounts.demo.routes";
import transferRoutes from "./features/banking/transfers/transfers.routes";
import paymentRoutes from "./features/banking/payments/payments.routes";
import payeeRoutes from "./features/banking/payees/payees.routes";
import interbankRoutes from "./features/banking/interbank/interbank.routes";
// spend — chi tiêu doanh nghiệp
import cardRoutes from "./features/spend/cards/cards.routes";
import budgetRoutes from "./features/spend/budgets/budgets.routes";
import claimRoutes from "./features/spend/claims/claims.routes";
import receiptRoutes from "./features/spend/claims/receipts.routes";
import billRoutes from "./features/spend/bills/bills.routes";
import categoryRoutes from "./features/spend/categories/categories.routes";
import spendPolicyRoutes from "./features/spend/spendPolicy/spendPolicy.routes";
// lending — tín dụng
import creditRoutes from "./features/lending/credit/credit.routes";
import drawdownRoutes from "./features/lending/drawdown/drawdown.routes";
import repaymentRoutes from "./features/lending/repayment/repayment.routes";
// compliance — định danh và phê duyệt
import kybRoutes from "./features/compliance/kyb/kyb.routes";
import kycRoutes from "./features/compliance/kyc/kyc.routes";
import approvalsRoutes from "./features/compliance/approvals/approvals.routes";
// backoffice — dành cho nhân viên ngân hàng
import adminRoutes from "./features/backoffice/admin/admin.routes";
import activityRoutes from "./features/backoffice/activity/activity.routes";
// platform — tài khoản người dùng và tiện ích dùng chung
import authRoutes from "./features/platform/auth/auth.routes";
import teamRoutes from "./features/platform/team/team.routes";
import subscriptionRoutes from "./features/platform/subscription/subscription.routes";
import notificationRoutes from "./features/platform/notifications/notifications.routes";
import alertRoutes from "./features/platform/alerts/alerts.routes";
import searchRoutes from "./features/platform/search/search.routes";
import assistantRoutes from "./features/platform/assistant/assistant.routes";
import developerRoutes from "./features/platform/developer/developer.routes";
import publicApiRoutes from "./features/platform/publicApi/publicApi.routes";

// Express 4 doesn't forward a rejected promise from an `async (req, res) =>
// {...}` route handler to the error middleware below — it becomes an
// unhandled rejection instead, which crashes the whole process (taking down
// every in-flight request, not just the one that errored). These two
// handlers are a safety net: they keep the server alive and let the request
// that triggered the error simply time out client-side, instead of the
// entire backend going down for everyone. The underlying error should still
// be fixed (check the logged stack trace) — this just contains the blast
// radius while that happens.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection — see stack trace above");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — see stack trace above");
});

const app = express();
const PORT = env.PORT;

// Trusts the reverse proxy's X-Forwarded-For so the rate limiters below key
// on the real client IP instead of the proxy's — without this every request
// looks like it comes from one address and shares a single bucket.
app.set("trust proxy", 1);

app.use(helmet());

app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  })
);
app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json({ limit: "15mb" }));

// Health check sits above the limiters so uptime probes never get throttled.
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api", generalLimiter);

// Auth first: it's the only prefix with its own (tighter) rate limiter.
app.use("/api/auth", authLimiter, authRoutes);

// --- banking ---------------------------------------------------------------
// Demo routes mount first: they own two specific paths under the same
// prefix and 404 themselves outside development, falling through to the real
// account routes below in every other case.
app.use("/api/accounts", accountDemoRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/transfers", transferRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/payees", payeeRoutes);
app.use("/api/interbank", interbankRoutes);

// --- spend -----------------------------------------------------------------
app.use("/api/cards", cardRoutes);
app.use("/api/budgets", budgetRoutes);
app.use("/api/claims", claimRoutes);
app.use("/api/receipts", receiptRoutes);
app.use("/api/bills", billRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/spend-policy", spendPolicyRoutes);

// --- lending ---------------------------------------------------------------
app.use("/api/credit", creditRoutes);
app.use("/api/drawdown", drawdownRoutes);
app.use("/api/repayment", repaymentRoutes);

// --- compliance ------------------------------------------------------------
app.use("/api/kyb", kybRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/approvals", approvalsRoutes);

// --- backoffice ------------------------------------------------------------
app.use("/api/admin", adminRoutes);
app.use("/api/activity", activityRoutes);

// --- platform --------------------------------------------------------------
app.use("/api/team", teamRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/assistant", assistantRoutes);
app.use("/api/developer", developerRoutes);
// Public API last, on its own prefix and its own rate limiter.
app.use("/api/v1", publicApiLimiter, publicApiRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Central error handler — every route throws AppError subclasses instead of
// building res.status(...).json(...) itself; see middleware/errorHandler.ts.
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`Backend listening on http://localhost:${PORT}`);
});
