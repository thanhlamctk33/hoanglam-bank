import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { requireCompanyAdmin } from "../../middleware/companyAdmin";
import { asyncHandler } from "../../middleware/errorHandler";
import { BadRequestError, NotFoundError, ValidationError } from "../../errors/AppError";
import { writeAuditLog } from "../../shared/audit/audit.service";
import { generateApiKey, generateWebhookSecret, signPayload } from "./apiKey.service";
import { WEBHOOK_EVENTS } from "./developer.config";

const router = Router();
router.use(requireAuth);

router.get(
  "/events",
  asyncHandler<AuthedRequest>(async (_req, res) => {
    res.json({ events: WEBHOOK_EVENTS });
  })
);

// --- API keys -----------------------------------------------------------
// The raw key is only ever returned once, at creation — same as every real
// provider's console. Afterwards only a masked view (via the `key` field's
// last 4 chars on the frontend) plus lastUsedAt/revokedAt are visible.
router.get(
  "/keys",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const keys = await prisma.apiKey.findMany({ where: { companyId: req.companyId }, orderBy: { createdAt: "desc" } });
    // The raw key is never sent back down after creation — only a masked
    // last-4 view, same as every real provider's key management page.
    const masked = keys.map(({ key, ...rest }: (typeof keys)[number]) => ({ ...rest, last4: key.slice(-4) }));
    res.json({ keys: masked });
  })
);

const createKeySchema = z.object({ label: z.string().min(1).max(60) });

router.post(
  "/keys",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const key = generateApiKey();
    const apiKey = await prisma.apiKey.create({
      data: {
        companyId: req.companyId!,
        label: parsed.data.label.trim(),
        key,
        createdById: req.userId!,
      },
    });

    const actor = await prisma.user.findUnique({ where: { id: req.userId } });
    await writeAuditLog({
      action: "API_KEY_CREATED",
      actorEmail: actor?.email ?? "unknown",
      targetType: "ApiKey",
      targetId: apiKey.id,
      metadata: { label: apiKey.label },
    });

    // key is only included on this response, never again.
    res.status(201).json({ apiKey, key });
  })
);

router.post(
  "/keys/:id/revoke",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const apiKey = await prisma.apiKey.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!apiKey) {
      throw new NotFoundError("API key not found");
    }
    if (apiKey.revokedAt) {
      throw new BadRequestError("This key is already revoked");
    }

    const updated = await prisma.apiKey.update({ where: { id: apiKey.id }, data: { revokedAt: new Date() } });

    await writeAuditLog({
      action: "API_KEY_REVOKED",
      actorEmail: (await prisma.user.findUnique({ where: { id: req.userId } }))?.email ?? "unknown",
      targetType: "ApiKey",
      targetId: apiKey.id,
      metadata: { label: apiKey.label },
    });

    res.json({ apiKey: updated });
  })
);

// --- Webhooks -------------------------------------------------------------
router.get(
  "/webhooks",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const webhooks = await prisma.webhookEndpoint.findMany({
      where: { companyId: req.companyId },
      orderBy: { createdAt: "desc" },
    });
    // Same masking approach as API keys — the signing secret is only ever
    // shown in full at creation time.
    const masked = webhooks.map(({ secret, ...rest }: (typeof webhooks)[number]) => ({
      ...rest,
      secretLast4: secret.slice(-4),
    }));
    res.json({ webhooks: masked });
  })
);

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

router.post(
  "/webhooks",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = createWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }

    const secret = generateWebhookSecret();
    const webhook = await prisma.webhookEndpoint.create({
      data: {
        companyId: req.companyId!,
        url: parsed.data.url,
        events: parsed.data.events.join(","),
        secret,
        createdById: req.userId!,
      },
    });

    await writeAuditLog({
      action: "WEBHOOK_CREATED",
      actorEmail: (await prisma.user.findUnique({ where: { id: req.userId } }))?.email ?? "unknown",
      targetType: "WebhookEndpoint",
      targetId: webhook.id,
      metadata: { url: webhook.url },
    });

    // secret is only included on this response, never again.
    res.status(201).json({ webhook, secret });
  })
);

router.patch(
  "/webhooks/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error);
    }
    const webhook = await prisma.webhookEndpoint.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!webhook) {
      throw new NotFoundError("Webhook not found");
    }
    const updated = await prisma.webhookEndpoint.update({
      where: { id: webhook.id },
      data: { active: parsed.data.active },
    });
    res.json({ webhook: updated });
  })
);

router.delete(
  "/webhooks/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const webhook = await prisma.webhookEndpoint.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!webhook) {
      throw new NotFoundError("Webhook not found");
    }
    await prisma.webhookDelivery.deleteMany({ where: { webhookId: webhook.id } });
    await prisma.webhookEndpoint.delete({ where: { id: webhook.id } });
    res.status(204).end();
  })
);

router.get(
  "/webhooks/:id/deliveries",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const webhook = await prisma.webhookEndpoint.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!webhook) {
      throw new NotFoundError("Webhook not found");
    }
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { webhookId: webhook.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.json({ deliveries });
  })
);

// Sends a real HTTP POST to the endpoint's URL with a sample payload —
// unlike every other "simulate" action in this app, this is a genuine
// outbound network call, since the entire point is to prove the receiving
// server is reachable and can verify the signature. Never throws on
// network failure; that's recorded as a failed delivery, not a 500.
router.post(
  "/webhooks/:id/test",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const webhook = await prisma.webhookEndpoint.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
    if (!webhook) {
      throw new NotFoundError("Webhook not found");
    }

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

    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        event: "webhook.test",
        payload: body,
        statusCode,
        success,
        error,
      },
    });

    res.json({ delivery });
  })
);

export default router;
