/**
 * Image attachments on the submission wire.
 *
 * pi-ai's user content is `string | (TextContent | ImageContent)[]` and pi-durable stores and
 * replays that verbatim (`UserInput`), so a message carrying an image needs no new schema — only a
 * gate on what a client is allowed to put in it. This module is that gate, plus the two text
 * projections the rest of Hearth needs: the plain text (keyword context) and a bounded preview
 * (the queue rows).
 *
 * Validation mirrors the `view` tool (`./view`): the **bytes decide the format**, never the
 * declared mime, so a mislabelled file cannot smuggle non-image data into a model's vision input.
 * The per-image cap is that tool's read cap, and the totals cover the composer's budget
 * (10 MB per file / 18 MB per message), so a client never sends something Hearth would drop.
 */
import { Buffer } from "node:buffer";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import { MAX_IMAGE_BYTES, detectImageMimeType } from "./view";

/** Images one submission may carry, and the decoded total it may carry them in. */
export const MAX_IMAGES_PER_INPUT = 8;
export const MAX_TOTAL_IMAGE_BYTES = 18 * 1024 * 1024;
/** Base64 is four characters per three bytes; reject before decoding something absurd. */
export const base64LengthLimit = (bytes: number): number => Math.ceil((bytes / 3) * 4) + 4;

const DATA_URL_PREFIX = /^data:[^;,]*;base64,/i;

export type UserInputParse = { ok: true; content: UserInput } | { ok: false; reason: string };

/**
 * Content a client may submit: a non-blank string, or a non-empty list of text and image parts that
 * is not blank overall. Only what a human turn can carry is accepted — no thinking, no tool calls.
 * A data-URL prefix on `data` is stripped rather than refused, since the bytes are what matter.
 */
export const parseUserInputContent = (value: unknown): UserInputParse => {
  if (typeof value === "string") {
    // Unchanged by attachments: a text-only message still may not be blank. The string is passed
    // through exactly as sent (no trim), as it always was.
    return value.trim()
      ? { ok: true, content: value }
      : { ok: false, reason: "content must not be empty" };
  }
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, reason: "content must be a string or a non-empty array of content parts" };
  }

  const parts: Array<TextContent | ImageContent> = [];
  let images = 0;
  let totalBytes = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "every content part must be an object" };
    }
    const part = raw as Record<string, unknown>;
    if (part.type === "text") {
      if (typeof part.text !== "string") return { ok: false, reason: "a text part needs a string `text`" };
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type !== "image") {
      return { ok: false, reason: `unsupported content part: ${String(part.type)}` };
    }
    if (typeof part.data !== "string") return { ok: false, reason: "an image part needs base64 `data`" };
    const data = part.data.replace(DATA_URL_PREFIX, "");
    const perImage = MAX_IMAGE_BYTES / 1024 / 1024;
    if (!data) return { ok: false, reason: "an image part needs base64 `data`" };
    if (data.length > base64LengthLimit(MAX_IMAGE_BYTES)) {
      return { ok: false, reason: `each image must be at most ${perImage}MB` };
    }
    images += 1;
    if (images > MAX_IMAGES_PER_INPUT) {
      return { ok: false, reason: `at most ${MAX_IMAGES_PER_INPUT} images per message` };
    }
    const bytes = Buffer.from(data, "base64");
    const mimeType = detectImageMimeType(bytes);
    if (!mimeType) {
      return { ok: false, reason: "not a supported image (PNG, JPEG, GIF, WebP or BMP)" };
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return { ok: false, reason: `each image must be at most ${perImage}MB` };
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return { ok: false, reason: `images must total at most ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024}MB` };
    }
    // The sniffed mime wins: a wrong declared type would only tell the model to decode real bytes
    // as something they are not.
    parts.push({ type: "image", data, mimeType });
  }

  const text = inputTextOf(parts);
  const hasImage = parts.some((part) => part.type === "image");
  if (!hasImage && !text.trim()) {
    return { ok: false, reason: "content must not be empty" };
  }
  return { ok: true, content: parts };
};

/** True when a submission's content carries at least one image part. */
export const carriesImage = (content: unknown): boolean =>
  Array.isArray(content) &&
  content.some((part) => part !== null && typeof part === "object" && (part as { type?: unknown }).type === "image");

/**
 * Why a model cannot be handed this submission, when its catalog entry has no `image` input.
 *
 * The image gate above only checks the bytes. What a model can *see* is its catalog entry's
 * `input`, and pi-ai acts on that either way: a model that does not list `image` has every image
 * replaced by the placeholder text `(image omitted: model does not support images)` before the
 * request is built (`transformMessages`). The turn then succeeds with a normal 200 and the model
 * reports that it saw nothing — indistinguishable from a broken client, a bad upload or a blind
 * model. Naming it at the wire keeps a misconfiguration from looking like a dumb model.
 */
export const blindModelReason = (
  content: unknown,
  model: { provider: string; id: string; input?: readonly string[] } | undefined
): string | undefined => {
  if (!model || !carriesImage(content)) return undefined;
  // An entry with no declared input is unknown, not blind: let the turn run and fail honestly.
  if (!Array.isArray(model.input) || model.input.includes("image")) return undefined;
  return (
    `${model.provider}/${model.id} does not accept images (its catalog entry has no image input): ` +
    "remove the image or choose a model that can see it"
  );
};

/** The plain text of a submission, for keyword-context matching. Images contribute nothing. */
export const inputTextOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : ""
    )
    .join("");
};

/**
 * Bounded preview of a submission for a queue row: its text, with images named rather than dropped
 * (an image-only message would otherwise preview as nothing at all).
 */
export const contentPreviewOf = (content: unknown, limit = 500): string => {
  if (typeof content === "string") return content.slice(0, limit);
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const type = (part as { type?: unknown }).type;
      if (type === "text") return String((part as { text?: unknown }).text ?? "");
      return type === "image" ? "[image]" : "";
    })
    .filter((token) => token !== "")
    .join(" ")
    .trim()
    .slice(0, limit);
};
