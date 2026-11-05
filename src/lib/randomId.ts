/**
 * A random id, wherever this renderer is actually running.
 *
 * `crypto.randomUUID()` is only defined in a **secure context** (HTTPS, or `localhost`). Ember's
 * remote access serves this same renderer over plain HTTP on a Tailscale address, which browsers
 * treat as insecure — so a browser pointed at another machine's Ember had no `crypto.randomUUID` at
 * all, and the first thing to ask for one (a submit's `requestId`) threw
 * "crypto.randomUUID is not a function". The screen was fine and every action was dead.
 *
 * `crypto.getRandomValues` is **not** restricted that way, so the fallback builds a v4 UUID from it
 * and the ids keep their shape (ids are compared and logged across clients). `Math.random` is the last
 * resort, for an environment with no `crypto` at all: weaker uniqueness is a much better failure than
 * a dead button, and it never happens on a browser.
 */

/** Render 16 random bytes as a v4 UUID: version nibble 4, variant bits 10. */
export const uuidFromBytes = (bytes: Uint8Array): string => {
  const out = new Uint8Array(bytes.subarray(0, 16));
  out[6] = (out[6] & 0x0f) | 0x40;
  out[8] = (out[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (const byte of out) hex.push(byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
};

export const randomId = (): string => {
  const source = globalThis.crypto as Crypto | undefined;
  if (typeof source?.randomUUID === 'function') {
    try {
      return source.randomUUID();
    } catch {
      // Some browsers ship the method and refuse the call; fall through rather than fail the action.
    }
  }
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === 'function') {
    try {
      source.getRandomValues(bytes);
      return uuidFromBytes(bytes);
    } catch {
      // Fall through to Math.random.
    }
  }
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return uuidFromBytes(bytes);
};
