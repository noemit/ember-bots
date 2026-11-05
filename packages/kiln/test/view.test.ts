import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { detectImageMimeType } from "../src/view";

/** A real 1×1 PNG (signature + IHDR), enough for the sniffer. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

const ascii = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "binary"));

describe("detectImageMimeType", () => {
  test("recognizes the formats pi-ai accepts as image content", () => {
    expect(detectImageMimeType(new Uint8Array(Buffer.from(PNG_1X1, "base64")))).toBe("image/png");
    expect(detectImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image/jpeg");
    expect(detectImageMimeType(ascii("GIF89a......"))).toBe("image/gif");
    expect(
      detectImageMimeType(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]))
    ).toBe("image/webp");
    expect(detectImageMimeType(ascii("BM......"))).toBe("image/bmp");
  });

  test("rejects text and unknown bytes", () => {
    expect(detectImageMimeType(ascii("hello world"))).toBeUndefined();
    expect(detectImageMimeType(new Uint8Array(0))).toBeUndefined();
    // A truncated PNG signature is not an image.
    expect(detectImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });
});
