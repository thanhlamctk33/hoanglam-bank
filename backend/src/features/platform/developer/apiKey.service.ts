import crypto from "crypto";
import { API_KEY_PREFIX } from "./developer.config";

/** Generates a demo API key — not a real secret-strength requirement, just enough to look and behave like one. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
}

/** Generates a webhook signing secret, shown once at creation like a real provider would. */
export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString("hex")}`;
}

/** HMAC-SHA256 signs a webhook payload the same way it'll be verified on the receiving end. */
export function signPayload(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}
