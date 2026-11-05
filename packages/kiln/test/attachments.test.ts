import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  MAX_IMAGES_PER_INPUT,
  MAX_TOTAL_IMAGE_BYTES,
  blindModelReason,
  carriesImage,
  contentPreviewOf,
  inputTextOf,
  parseUserInputContent,
} from "../src/images";
import { MAX_IMAGE_BYTES } from "../src/view";

/** A real 1×1 PNG, so the sniff succeeds. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

/** A PNG of `size` bytes: signature + IHDR (what the sniffer reads), then padding. */
const pngOf = (size: number): string => {
  const bytes = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  Buffer.from("IHDR").copy(bytes, 12);
  return bytes.toString("base64");
};

const text = (value: string) => ({ type: "text", text: value });
const image = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });

describe("parseUserInputContent", () => {
  test("keeps plain text exactly as it was sent", () => {
    expect(parseUserInputContent("  hello  ")).toEqual({ ok: true, content: "  hello  " });
  });

  test("refuses blank text", () => {
    expect(parseUserInputContent("   ").ok).toBe(false);
    expect(parseUserInputContent("").ok).toBe(false);
  });

  test("accepts text parts", () => {
    const parsed = parseUserInputContent([text("look at this")]);
    expect(parsed).toEqual({ ok: true, content: [{ type: "text", text: "look at this" }] });
  });

  test("accepts an image part and takes the mime from the bytes", () => {
    const parsed = parseUserInputContent([text("what is this"), image(PNG_1X1)]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", data: PNG_1X1, mimeType: "image/png" },
    ]);
  });

  test("an image alone is a valid message; a declared mime is a hint, not the truth", () => {
    const parsed = parseUserInputContent([image(PNG_1X1, "image/jpeg")]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.content).toEqual([{ type: "image", data: PNG_1X1, mimeType: "image/png" }]);
  });

  test("strips a data-URL prefix", () => {
    const parsed = parseUserInputContent([image(`data:image/png;base64,${PNG_1X1}`)]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.content).toEqual([{ type: "image", data: PNG_1X1, mimeType: "image/png" }]);
  });

  test("refuses parts a human turn cannot carry", () => {
    expect(parseUserInputContent([{ type: "thinking", thinking: "..." }]).ok).toBe(false);
    expect(parseUserInputContent([{ type: "toolCall", id: "1", name: "read" }]).ok).toBe(false);
    expect(parseUserInputContent([null]).ok).toBe(false);
    expect(parseUserInputContent([["nested"]]).ok).toBe(false);
    expect(parseUserInputContent([]).ok).toBe(false);
  });

  test("refuses malformed and non-image content", () => {
    expect(parseUserInputContent([text("   ")]).ok).toBe(false);
    expect(parseUserInputContent([{ type: "text" }]).ok).toBe(false);
    expect(parseUserInputContent([image("")]).ok).toBe(false);
    expect(parseUserInputContent([image(Buffer.from("hello").toString("base64"))]).ok).toBe(false);
    expect(parseUserInputContent({}).ok).toBe(false);
    expect(parseUserInputContent(undefined).ok).toBe(false);
  });

  test("refuses an image over the per-image cap", () => {
    const oversized = "A".repeat(Math.ceil((MAX_IMAGE_BYTES / 3) * 4) + 8);
    const parsed = parseUserInputContent([image(oversized)]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("at most 12MB");
  });

  test("refuses more images than one message may carry", () => {
    const parsed = parseUserInputContent(
      Array.from({ length: MAX_IMAGES_PER_INPUT + 1 }, () => image(PNG_1X1))
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain(`at most ${MAX_IMAGES_PER_INPUT} images`);
  });

  test("refuses images over the per-message total", () => {
    // Two valid PNGs of 10MB decode to 20MB, past the 18MB message budget.
    const parsed = parseUserInputContent([image(pngOf(10 * 1024 * 1024)), image(pngOf(10 * 1024 * 1024))]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain(`images must total at most ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024}MB`);
  });
});

describe("inputTextOf", () => {
  test("reads text parts and ignores images", () => {
    expect(inputTextOf("plain")).toBe("plain");
    expect(inputTextOf([text("a"), image(PNG_1X1), text("b")])).toBe("ab");
    expect(inputTextOf([image(PNG_1X1)])).toBe("");
    expect(inputTextOf(undefined)).toBe("");
  });
});

describe("contentPreviewOf", () => {
  test("names images instead of dropping them", () => {
    expect(contentPreviewOf("hello")).toBe("hello");
    expect(contentPreviewOf([image(PNG_1X1)])).toBe("[image]");
    expect(contentPreviewOf([text("look"), image(PNG_1X1)])).toBe("look [image]");
  });

  test("stays bounded", () => {
    expect(contentPreviewOf("x".repeat(900)).length).toBe(500);
  });
});

describe("carriesImage", () => {
  test("sees images anywhere in the parts", () => {
    expect(carriesImage([text("a"), image(PNG_1X1)])).toBe(true);
    expect(carriesImage([image(PNG_1X1)])).toBe(true);
    expect(carriesImage([text("a")])).toBe(false);
    expect(carriesImage("a string")).toBe(false);
    expect(carriesImage(undefined)).toBe(false);
    expect(carriesImage([null, 7])).toBe(false);
  });
});

describe("blindModelReason", () => {
  const content = [text("what is this?"), image(PNG_1X1)];
  const vision = { provider: "deepseek", id: "deepseek-flash", input: ["text", "image"] };
  const blind = { provider: "opencode", id: "deepseek-v4-flash", input: ["text"] };

  test("names a model whose catalog entry has no image input", () => {
    // Without this refusal pi-ai swaps the image for "(image omitted: model does not support
    // images)" and the turn succeeds — the model reports seeing nothing, and nothing says why.
    const reason = blindModelReason(content, blind);
    expect(reason).toContain("opencode/deepseek-v4-flash");
    expect(reason).toContain("does not accept images");
  });

  test("allows a model that can see, and text-only messages to any model", () => {
    expect(blindModelReason(content, vision)).toBeUndefined();
    expect(blindModelReason([text("just text")], blind)).toBeUndefined();
    expect(blindModelReason("a string", blind)).toBeUndefined();
  });

  test("does not guess when the capability or the model is unknown", () => {
    // No declared input means unknown, not blind: the turn runs and fails honestly if it must.
    expect(blindModelReason(content, { provider: "p", id: "i" })).toBeUndefined();
    expect(blindModelReason(content, { provider: "p", id: "i", input: undefined })).toBeUndefined();
    expect(blindModelReason(content, undefined)).toBeUndefined();
  });
});
