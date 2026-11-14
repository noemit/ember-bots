/** Image identity helpers shared by renderer reconciliation and Pi wire mapping. */

/** Browser-safe decoder with the permissive semantics of Node's Buffer base64 decoder. */
export const decodeBase64Bytes = (data: string): Uint8Array => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const sextets: number[] = [];
  for (const char of data) {
    if (char === '=') break;
    if (char === '-' || char === '_') {
      sextets.push(char === '-' ? 62 : 63);
      continue;
    }
    // Node's base64 decoder ignores ASCII whitespace, punctuation, and non-ASCII input.
    if (char.charCodeAt(0) > 0x7f) continue;
    const value = alphabet.indexOf(char);
    if (value >= 0) sextets.push(value);
  }
  const byteLength = Math.floor((sextets.length * 6) / 8);
  const bytes = new Uint8Array(byteLength);
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const value of sextets) {
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (accumulator >> bits) & 0xff;
    }
  }
  return bytes;
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
const startsWithAscii = (bytes: Uint8Array, offset: number, text: string): boolean =>
  bytes.length >= offset + text.length &&
  [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));

/** The formats Kiln accepts; MIME headers never override a recognized byte signature. */
export const detectImageMimeType = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return bytes[3] === 0xf7 ? undefined : 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return startsWithAscii(bytes, 12, 'IHDR') ? 'image/png' : undefined;
  }
  if (startsWithAscii(bytes, 0, 'GIF87a') || startsWithAscii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (startsWithAscii(bytes, 0, 'RIFF') && startsWithAscii(bytes, 8, 'WEBP')) return 'image/webp';
  if (startsWithAscii(bytes, 0, 'BM')) return 'image/bmp';
  return undefined;
};

/** Compact deterministic digest over decoded image bytes and their effective MIME. */
export const imageContentDigest = (mime: string, data: string): string => {
  const bytes = decodeBase64Bytes(data);
  const effectiveMime = detectImageMimeType(bytes) ?? mime;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const prefix = `${effectiveMime}:${bytes.byteLength}:`;
  const feed = (code: number) => {
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  };
  for (let index = 0; index < prefix.length; index += 1) feed(prefix.charCodeAt(index));
  for (const byte of bytes) feed(byte);
  return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
};
