import "dotenv/config";
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { errorHandler } from "./middleware/errorHandler";
import authRoutes from "./features/auth/auth.routes";
import accountRoutes from "./features/accounts/accounts.routes";
import cardRoutes from "./features/cards/cards.routes";
import budgetRoutes from "./features/budgets/budgets.routes";
import claimRoutes from "./features/claims/claims.routes";
import receiptRoutes from "./features/claims/receipts.routes";
import billRoutes from "./features/bills/bills.routes";
import assistantRoutes from "./features/assistant/assistant.routes";
import transferRoutes from "./features/transfers/transfers.routes";
import paymentRoutes from "./features/payments/payments.routes";
import adminRoutes from "./features/admin/admin.routes";
import subscriptionRoutes from "./features/subscription/subscription.routes";
import kybRoutes from "./features/kyb/kyb.routes";
import kycRoutes from "./features/kyc/kyc.routes";
import approvalsRoutes from "./features/approvals/approvals.routes";
import teamRoutes from "./features/team/team.routes";
import creditRoutes from "./features/credit/credit.routes";
import drawdownRoutes from "./features/drawdown/drawdown.routes";
import repaymentRoutes from "./features/repayment/repayment.routes";
import notificationRoutes from "./features/notifications/notifications.routes";
import activityRoutes from "./features/activity/activity.routes";
import searchRoutes from "./features/search/search.routes";
import payeeRoutes from "./features/payees/payees.routes";
import categoryRoutes from "./features/categories/categories.routes";
import spendPolicyRoutes from "./features/spendPolicy/spendPolicy.routes";
import interbankRoutes from "./features/interbank/interbank.routes";
import alertRoutes from "./features/alerts/alerts.routes";
import developerRoutes from "./features/developer/developer.routes";
import publicApiRoutes from "./features/publicApi/publicApi.routes";

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
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

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
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3000" }));
app.use(express.json({ limit: "15mb" }));

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/cards", cardRoutes);
app.use("/api/budgets", budgetRoutes);
app.use("/api/claims", claimRoutes);
app.use("/api/receipts", receiptRoutes);
app.use("/api/bills", billRoutes);
app.use("/api/assistant", assistantRoutes);
app.use("/api/transfers", transferRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/kyb", kybRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/approvals", approvalsRoutes);
app.use("/api/team", teamRoutes);
app.use("/api/credit", creditRoutes);
app.use("/api/drawdown", drawdownRoutes);
app.use("/api/repayment", repaymentRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/payees", payeeRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/spend-policy", spendPolicyRoutes);
app.use("/api/interbank", interbankRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/developer", developerRoutes);
app.use("/api/v1", publicApiRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Central error handler — every route throws AppError subclasses instead of
// building res.status(...).json(...) itself; see middleware/errorHandler.ts.
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`Backend listening on http://localhost:${PORT}`);
});
