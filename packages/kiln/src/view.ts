import { Buffer } from "node:buffer";
import type { Context } from "@earendil-works/chord";
import type { ImageContent } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";

/**
 * `view` — show an image file to both the model and the user.
 *
 * pi-durable's `read` refuses images outright ("reading images is not supported"), so an agent that
 * is handed a screenshot (say, one dropped into the sync folder) cannot see it even on a
 * vision-capable model. This tool reads the bytes, sniffs the format, and returns the image as an
 * `ImageContent` block — the same shape MCP image results use (see `src/mcp.ts`), which pi-ai sends
 * to the model's vision input rather than stringifying.
 */

/** The provider layer resizes, but a huge file should not be read into memory first. It is also
 *  the per-image cap a submission is held to (`./images`). */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (buffer: Uint8Array, bytes: readonly number[]): boolean =>
  buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);

const startsWithAscii = (buffer: Uint8Array, offset: number, text: string): boolean => {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
};

/** PNG, JPEG, GIF, WebP or BMP — the formats pi-ai accepts as image content. */
export const detectImageMimeType = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return bytes[3] === 0xf7 ? undefined : "image/jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return startsWithAscii(bytes, 12, "IHDR") ? "image/png" : undefined;
  if (startsWithAscii(bytes, 0, "GIF87a") || startsWithAscii(bytes, 0, "GIF89a")) return "image/gif";
  if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) return "image/webp";
  if (startsWithAscii(bytes, 0, "BM")) return "image/bmp";
  return undefined;
};

export const createViewTool = (): ToolRegistration =>
  defineTool({
    name: "view",
    description:
      "Look at an image file (PNG, JPEG, GIF, WebP or BMP) so you can actually see it. Use this " +
      "for screenshots and other images; `read` only handles text. The image is also displayed " +
      "to the user in the conversation, so calling `view` shares it with them; it is not private inspection.",
    parameters: obj({
      path: str({ description: "Path to the image file (relative or absolute)" }),
    }),
    replay: "safe",
    execute: async (args, api: ToolExecutionApi, context: Context) => {
      const env = api.env;
      if (env === undefined) {
        return {
          output: [{ type: "text", text: "No execution environment is configured." }],
          isError: true,
        };
      }
      const absolutePath = getOrThrow(await env.absolutePath(args.path, context));
      const bytes = getOrThrow(await env.readBinaryFile(absolutePath, context));
      const mimeType = detectImageMimeType(bytes);
      if (!mimeType) {
        return {
          output: [
            { type: "text", text: `${args.path} is not a supported image (PNG, JPEG, GIF, WebP or BMP).` },
          ],
          isError: true,
        };
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return {
          output: [
            {
              type: "text",
              text: `${args.path} is ${Math.round(bytes.byteLength / 1024 / 1024)}MB, too large to view (limit ${MAX_IMAGE_BYTES / 1024 / 1024}MB).`,
            },
          ],
          isError: true,
        };
      }
      const image: ImageContent = {
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType,
      };
      return { output: [image] };
    },
  });

/** The `view` tool as its own extension, so a conversation can deselect it. */
export const View = { name: "view", tools: [createViewTool()] } as const;
