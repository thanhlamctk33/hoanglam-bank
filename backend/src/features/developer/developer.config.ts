/** Developer API defaults: sample webhook event types a company can subscribe to. */
export const WEBHOOK_EVENTS = [
  "transaction.created",
  "transfer.completed",
  "bill.paid",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const API_KEY_PREFIX = "lb_live_";
