import { prisma } from "../../lib/prisma";

/**
 * Thin Prisma wrappers for the developer console (API keys + webhooks) —
 * developer.service.ts never touches `prisma` itself. Every lookup is scoped
 * by companyId so one company can't reach another's keys or endpoints.
 */

// --- API keys -----------------------------------------------------------------

export function findApiKeysByCompany(companyId: string) {
  return prisma.apiKey.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}

export function findOwnApiKey(companyId: string, id: string) {
  return prisma.apiKey.findFirst({ where: { id, companyId } });
}

export function createApiKeyRecord(data: { companyId: string; label: string; key: string; createdById: string }) {
  return prisma.apiKey.create({ data });
}

export function revokeApiKeyRecord(id: string) {
  return prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
}

// --- Webhook endpoints ------------------------------------------------------------

export function findWebhooksByCompany(companyId: string) {
  return prisma.webhookEndpoint.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}

export function findOwnWebhook(companyId: string, id: string) {
  return prisma.webhookEndpoint.findFirst({ where: { id, companyId } });
}

export function createWebhookRecord(data: {
  companyId: string;
  url: string;
  events: string;
  secret: string;
  createdById: string;
}) {
  return prisma.webhookEndpoint.create({ data });
}

export function setWebhookActive(id: string, active: boolean) {
  return prisma.webhookEndpoint.update({ where: { id }, data: { active } });
}

export function deleteWebhookRecord(id: string) {
  return prisma.webhookEndpoint.delete({ where: { id } });
}

// --- Webhook deliveries -------------------------------------------------------------

export function findDeliveriesForWebhook(webhookId: string) {
  return prisma.webhookDelivery.findMany({ where: { webhookId }, orderBy: { createdAt: "desc" }, take: 20 });
}

export function createDelivery(data: {
  webhookId: string;
  event: string;
  payload: string;
  statusCode: number | null;
  success: boolean;
  error: string | null;
}) {
  return prisma.webhookDelivery.create({ data });
}

export function deleteDeliveriesForWebhook(webhookId: string) {
  return prisma.webhookDelivery.deleteMany({ where: { webhookId } });
}
