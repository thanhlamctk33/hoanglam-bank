import { BadRequestError, NotFoundError } from "../../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../../shared/audit/audit.service";
import { generateApiKey, generateWebhookSecret, signPayload } from "./apiKey.service";
import { WEBHOOK_EVENTS } from "./developer.config";
import * as developerRepo from "./developer.repository";

/**
 * Business logic for the developer console — every route in
 * developer.routes.ts is a thin validate-then-call-this wrapper. All Prisma
 * access goes through developer.repository.ts.
 *
 * Both secrets in here (API key, webhook signing secret) are returned in
 * full exactly once, at creation. Every later read goes through the masking
 * helpers below, so a leaked list response can't be replayed.
 */

// --- API keys -----------------------------------------------------------------

export async function listApiKeys(companyId: string) {
  const keys = await developerRepo.findApiKeysByCompany(companyId);
  // The raw key is never sent back down after creation — only a masked
  // last-4 view, same as every real provider's key management page.
  return keys.map(({ key, ...rest }: (typeof keys)[number]) => ({ ...rest, last4: key.slice(-4) }));
}

export async function createApiKey(companyId: string, userId: string, label: string) {
  const key = generateApiKey();
  const apiKey = await developerRepo.createApiKeyRecord({
    companyId,
    label: label.trim(),
    key,
    createdById: userId,
  });

  await writeAuditLog({
    action: "API_KEY_CREATED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "ApiKey",
    targetId: apiKey.id,
    metadata: { label: apiKey.label },
  });

  // key is only included on this response, never again.
  return { apiKey, key };
}

export async function revokeApiKey(companyId: string, id: string, userId: string) {
  const apiKey = await developerRepo.findOwnApiKey(companyId, id);
  if (!apiKey) {
    throw new NotFoundError("API key not found");
  }
  if (apiKey.revokedAt) {
    throw new BadRequestError("This key is already revoked");
  }

  const updated = await developerRepo.revokeApiKeyRecord(apiKey.id);

  await writeAuditLog({
    action: "API_KEY_REVOKED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "ApiKey",
    targetId: apiKey.id,
    metadata: { label: apiKey.label },
  });

  return updated;
}

// --- Webhooks -------------------------------------------------------------------

export async function listWebhooks(companyId: string) {
  const webhooks = await developerRepo.findWebhooksByCompany(companyId);
  // Same masking approach as API keys — the signing secret is only ever
  // shown in full at creation time.
  return webhooks.map(({ secret, ...rest }: (typeof webhooks)[number]) => ({ ...rest, secretLast4: secret.slice(-4) }));
}

/** Loads a company's own webhook endpoint, or throws 404. */
async function requireOwnWebhook(companyId: string, id: string) {
  const webhook = await developerRepo.findOwnWebhook(companyId, id);
  if (!webhook) {
    throw new NotFoundError("Webhook not found");
  }
  return webhook;
}

export interface CreateWebhookParams {
  url: string;
  events: (typeof WEBHOOK_EVENTS)[number][];
}

export async function createWebhook(companyId: string, userId: string, params: CreateWebhookParams) {
  const secret = generateWebhookSecret();
  const webhook = await developerRepo.createWebhookRecord({
    companyId,
    url: params.url,
    events: params.events.join(","),
    secret,
    createdById: userId,
  });

  await writeAuditLog({
    action: "WEBHOOK_CREATED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "WebhookEndpoint",
    targetId: webhook.id,
    metadata: { url: webhook.url },
  });

  // secret is only included on this response, never again.
  return { webhook, secret };
}

export async function setWebhookActive(companyId: string, id: string, active: boolean) {
  const webhook = await requireOwnWebhook(companyId, id);
  return developerRepo.setWebhookActive(webhook.id, active);
}

export async function deleteWebhook(companyId: string, id: string) {
  const webhook = await requireOwnWebhook(companyId, id);
  await developerRepo.deleteDeliveriesForWebhook(webhook.id);
  await developerRepo.deleteWebhookRecord(webhook.id);
}

export async function listWebhookDeliveries(companyId: string, id: string) {
  const webhook = await requireOwnWebhook(companyId, id);
  return developerRepo.findDeliveriesForWebhook(webhook.id);
}

/**
 * Sends a real HTTP POST to the endpoint's URL with a sample payload —
 * unlike every other "simulate" action in this app, this is a genuine
 * outbound network call, since the entire point is to prove the receiving
 * server is reachable and can verify the signature. Never throws on
 * network failure; that's recorded as a failed delivery, not a 500.
 */
export async function sendTestDelivery(companyId: string, id: string) {
  const webhook = await requireOwnWebhook(companyId, id);

  const body = JSON.stringify({
    event: "webhook.test",
    createdAt: new Date().toISOString(),
    data: { message: "This is a test delivery from LamBank." },
  });
  const signature = signPayload(webhook.secret, body);

  let statusCode: number | null = null;
  let success = false;
  let error: string | null = null;

  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LamBank-Signature": signature },
      body,
      signal: AbortSignal.timeout(8000),
    });
    statusCode = response.status;
    success = response.ok;
    if (!success) error = `Endpoint responded with status ${response.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : "Request failed";
  }

  return developerRepo.createDelivery({
    webhookId: webhook.id,
    event: "webhook.test",
    payload: body,
    statusCode,
    success,
    error,
  });
}
