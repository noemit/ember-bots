import { describe, expect, test } from 'bun:test';
import * as app from './electron/tokenWords';
import * as kiln from './packages/kiln/src/token';

/**
 * The token word list exists twice, on purpose: `electron/tokenWords.ts` for the desktop app (which
 * displays and rotates tokens) and `packages/kiln/src/token.ts` for the harness and the CLI (which
 * write them). They cannot share a module — electron main is compiled with `rootDir: electron`.
 *
 * A duplicated list is only safe if something fails when the copies drift, so this does. The failure
 * it prevents is the quiet one: the app shows a token made from words the harness has never heard of,
 * every request 401s, and the two halves each look correct on their own.
 */
describe('one word list, two copies', () => {
  // Compared word by word rather than as one string: the two files wrap their lines differently, and
  // a line break moving is not drift. A word added to one copy and forgotten in the other is.
  test('the words are identical, in the same order', () => {
    expect(app.TOKEN_WORDS).toEqual(kiln.TOKEN_WORDS);
  });

  test('the words are well formed: lowercase, no duplicates', () => {
    expect(app.TOKEN_WORDS.length).toBe(new Set(app.TOKEN_WORDS).size);
    for (const word of app.TOKEN_WORDS) expect(word).toMatch(/^[a-z]+$/);
  });

  test('the list is big enough that four words is a real secret', () => {
    const bits = Math.log2(app.TOKEN_WORDS.length) * app.TOKEN_WORD_COUNT;
    // 40 bits is the floor worth shipping: 200 guesses a second needs decades to expect a hit.
    expect(bits).toBeGreaterThanOrEqual(40);
  });

  test('both generators produce four words from that list', () => {
    for (const generate of [app.generateToken, kiln.generateToken]) {
      const token = generate();
      const words = token.split('-');
      expect(words).toHaveLength(4);
      for (const word of words) expect(app.TOKEN_WORDS).toContain(word);
    }
  });

  test('both agree on what counts as a usable stored token', () => {
    for (const check of [app.isUsableToken, kiln.isUsableToken]) {
      expect(check('apple-venison-rainbow-copper')).toBe(true);
      // Hex from an older install is still a valid credential.
      expect(check('a'.repeat(64))).toBe(true);
      // A truncated write is not.
      expect(check('abc')).toBe(false);
      expect(check('   ')).toBe(false);
      expect(check(undefined)).toBe(false);
    }
  });

  test('a hundred draws are all different', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => app.generateToken()));
    expect(tokens.size).toBe(100);
  });
});
