import { describe, expect, test } from 'bun:test';
import { deriveSessionName } from '../src/lib/sessionNames';

describe('topic-relevant session names', () => {
  test('keeps the human subject and a relevant character', () => {
    expect(deriveSessionName({ text: 'Repair packaged ChatGPT sign-in' })).toBe('Login Locksmith');
    expect(deriveSessionName({ text: 'Fix token refresh' })).toBe('Token Locksmith');
    expect(deriveSessionName({ text: 'Animate the blobs' })).toBe('Blob Sculptor');
  });
  test('collisions preserve the subject instead of choosing unrelated animals', () => {
    const taken: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const name = deriveSessionName({ text: 'Fix login', taken });
      expect(name).toStartWith('Login ');
      expect(taken).not.toContain(name);
      expect(name.split(' ').length).toBeLessThanOrEqual(4);
      taken.push(name);
    }
  });
  test('uses unfamiliar subjects without importing folder names or polite scaffolding', () => {
    expect(deriveSessionName({ text: 'Can you please fix pagination', directory: '/work/hearth' })).toBe('Pagination Mechanic');
    expect(deriveSessionName({ text: 'ok', directory: '/work/hearth' })).not.toContain('Hearth');
  });
  test('does not use pasted credentials, code or URLs as a subject', () => {
    for (const text of ['password: huntersecret', 'https://private.example/login', '```ts\nconst token = secret\n```']) {
      const name = deriveSessionName({ text });
      expect(name).not.toMatch(/huntersecret|Private|Secret|Login|Token/);
    }
  });
  test('is stable across seeds, folder changes and repeated calls for a clear topic', () => {
    const first = deriveSessionName({ text: 'Repair login', seed: 'one' });
    expect(deriveSessionName({ text: 'Repair login', seed: 'two', directory: '/elsewhere' })).toBe(first);
  });
});
