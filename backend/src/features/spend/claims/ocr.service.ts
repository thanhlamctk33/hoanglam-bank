import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
const DOCUMENT_MIME_TYPES = ["application/pdf"] as const;

export const OCR_MIME_TYPES = [...IMAGE_MIME_TYPES, ...DOCUMENT_MIME_TYPES] as const;
export type OcrMimeType = (typeof OCR_MIME_TYPES)[number];

const PROMPT =
  'Read this receipt or invoice. Reply with ONLY a JSON object, no other text: {"title": "<short merchant/purpose description, e.g. \'Client dinner - Kobe Steakhouse\'>", "amount": <total amount as a plain number, no currency symbol>}. If you cannot read a field, use null for it.';

export async function extractReceiptFields(imageBase64: string, mimeType: OcrMimeType) {
  const isDocument = (DOCUMENT_MIME_TYPES as readonly string[]).includes(mimeType);

  const fileBlock = isDocument
    ? {
        type: "document" as const,
        source: { type: "base64" as const, media_type: "application/pdf" as const, data: imageBase64 },
      }
    : {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mimeType as (typeof IMAGE_MIME_TYPES)[number],
          data: imageBase64,
        },
      };

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [fileBlock, { type: "text", text: PROMPT }],
      },
    ],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  const rawText = textBlock && "text" in textBlock ? textBlock.text : "";
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Could not read the receipt.");
  }

  const extracted = JSON.parse(match[0]);
  return {
    title: typeof extracted.title === "string" ? extracted.title : null,
    amount: typeof extracted.amount === "number" ? extracted.amount : null,
  };
}
