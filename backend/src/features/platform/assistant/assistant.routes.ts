import fs from "fs";
import path from "path";
import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/errorHandler";
import { ServiceUnavailableError, ValidationError } from "../../../errors/AppError";
import { isAiConfigured } from "../../../config/env";
import { logger } from "../../../lib/logger";

const router = Router();
router.use(requireAuth);

const client = new Anthropic();

// The feature guide is a plain markdown file (src/knowledge/app-guide.md) so
// it's easy to keep in sync as features change without touching this route's
// code — the assistant just reads it fresh on every request and answers from it.
const KNOWLEDGE_PATH = path.join(__dirname, "../../../knowledge/app-guide.md");

function loadAppGuide(): string {
  try {
    return fs.readFileSync(KNOWLEDGE_PATH, "utf-8");
  } catch (err) {
    logger.error({ err }, "Failed to read app guide knowledge file");
    return "";
  }
}

function buildSystemPrompt(): string {
  const guide = loadAppGuide();
  return `You are the in-app support assistant for LamBank, a business banking web dashboard.
Help users understand how to use the app, using the feature guide below as your source of truth. Answer in the same language the user writes in (default to Vietnamese if unclear).

Keep answers short, concrete, and reference the exact page/menu name (e.g. "Spend > Claims") when telling the user where to go. If asked about something outside this app, politely say you can only help with using LamBank. If the guide doesn't cover something, say you're not sure rather than guessing.

<feature_guide>
${guide}
</feature_guide>`;
}

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      })
    )
    .min(1)
    .max(50),
});

router.post(
  "/chat",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsedBody = chatSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ValidationError(parsedBody.error);
    }

    if (!isAiConfigured) {
      throw new ServiceUnavailableError("AI assistant is not configured. Set ANTHROPIC_API_KEY in backend/.env.");
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");

    // Deliberately a local try/catch instead of throwing (the convention
    // used everywhere else — see middleware/errorHandler.ts): this response
    // streams text chunks via res.write() as they arrive, so by the time the
    // Anthropic call fails, headers/body bytes may already be on the wire.
    // The central error handler no-ops once headersSent is true, so this is
    // the only place that can still decide how to fail — a clean 502 if
    // nothing was sent yet, or just ending the stream if it was already
    // underway.
    try {
      const stream = client.messages.stream({
        model: "claude-opus-5",
        max_tokens: 1024,
        system: buildSystemPrompt(),
        messages: parsedBody.data.messages,
      });

      stream.on("text", (delta) => {
        res.write(delta);
      });

      await stream.finalMessage();
      res.end();
    } catch (err) {
      logger.error({ err }, "Assistant chat error");
      if (!res.headersSent) {
        res.status(502).json({ error: "Failed to reach the AI assistant." });
      } else {
        res.end();
      }
    }
  })
);

export default router;
