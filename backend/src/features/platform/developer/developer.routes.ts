import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { requireCompanyAdmin } from "../../../middleware/companyAdmin";
import { asyncHandler } from "../../../middleware/errorHandler";
import { ValidationError } from "../../../errors/AppError";
import { WEBHOOK_EVENTS } from "./developer.config";
import * as developerService from "./developer.service";

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
    const keys = await developerService.listApiKeys(req.companyId);
    res.json({ keys });
  })
);

const createKeySchema = z.object({ label: z.string().min(1).max(60) });

router.post(
  "/keys",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = createKeySchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const { apiKey, key } = await developerService.createApiKey(req.companyId, req.userId, parsedBody.data.label);
    res.status(201).json({ apiKey, key });
  })
);

router.post(
  "/keys/:id/revoke",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const apiKey = await developerService.revokeApiKey(req.companyId, req.params.id, req.userId);
    res.json({ apiKey });
  })
);

// --- Webhooks -------------------------------------------------------------
router.get(
  "/webhooks",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const webhooks = await developerService.listWebhooks(req.companyId);
    res.json({ webhooks });
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
    const parsedBody = createWebhookSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const { webhook, secret } = await developerService.createWebhook(req.companyId, req.userId, parsedBody.data);
    res.status(201).json({ webhook, secret });
  })
);

const updateWebhookSchema = z.object({ active: z.boolean() });

router.patch(
  "/webhooks/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = updateWebhookSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    const webhook = await developerService.setWebhookActive(req.companyId, req.params.id, parsedBody.data.active);
    res.json({ webhook });
  })
);

router.delete(
  "/webhooks/:id",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    await developerService.deleteWebhook(req.companyId, req.params.id);
    res.status(204).end();
  })
);

router.get(
  "/webhooks/:id/deliveries",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const deliveries = await developerService.listWebhookDeliveries(req.companyId, req.params.id);
    res.json({ deliveries });
  })
);

router.post(
  "/webhooks/:id/test",
  requireCompanyAdmin,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const delivery = await developerService.sendTestDelivery(req.companyId, req.params.id);
    res.json({ delivery });
  })
);

export default router;
