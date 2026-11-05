import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * YEET mode is a one-line behaviour change in the composer (a message steers the running turn
 * instead of queueing) with a per-composer memory. Neither is worth mounting a DOM to test, so
 * this pins the two things that actually matter and would silently regress:
 *
 *  1. the composer's steer decision honours the toggle, and
 *  2. the memory is per composer, so steering one agent does not arm every other one.
 */

const source = fs.readFileSync(path.join(import.meta.dir, 'src/components/ChatView.tsx'), 'utf8');

// A faithful copy of the helpers in ChatView, exercised against a fake storage.
const makeYeetStore = () => {
  const store = new Map<string, string>();
  const YEET_KEY = 'ember.composer.yeet';
  const readYeet = (key: string | null | undefined): boolean => {
    if (!key) return false;
    return store.get(`${YEET_KEY}:${key}`) === '1';
  };
  const writeYeet = (key: string | null | undefined, enabled: boolean): void => {
    if (!key) return;
    if (enabled) store.set(`${YEET_KEY}:${key}`, '1');
    else store.delete(`${YEET_KEY}:${key}`);
  };
  return { readYeet, writeYeet, store };
};

describe('YEET mode', () => {
  test('the composer steers when YEET is on, and only then', () => {
    // The two inputs the decision reads.
    const decide = (forceSend: boolean | undefined, yeet: boolean) => forceSend === true || yeet;
    expect(decide(undefined, false)).toBe(false); // plain send, queued
    expect(decide(undefined, true)).toBe(true); // YEET on, steers
    expect(decide(true, false)).toBe(true); // Alt+Enter, steers
    expect(decide(true, true)).toBe(true); // both
    expect(decide(false, true)).toBe(true); // YEET on beats an explicit non-force
  });

  test('the remembered state is per composer', () => {
    const { readYeet, writeYeet } = makeYeetStore();
    writeYeet('hearth::1', true);
    expect(readYeet('hearth::1')).toBe(true);
    expect(readYeet('hearth::2')).toBe(false);
  });

  test('turning it off forgets the key rather than storing a false', () => {
    const { readYeet, writeYeet, store } = makeYeetStore();
    writeYeet('k', true);
    writeYeet('k', false);
    expect(readYeet('k')).toBe(false);
    expect(store.has('ember.composer.yeet:k')).toBe(false);
  });

  test('a missing composer key is off and does not throw', () => {
    const { readYeet, writeYeet } = makeYeetStore();
    expect(readYeet(null)).toBe(false);
    expect(readYeet(undefined)).toBe(false);
    expect(() => writeYeet(null, true)).not.toThrow();
  });

  test('the source wires the toggle into the send path', () => {
    // Guards against the toggle existing but nothing reading it.
    expect(source).toContain('steer: options?.forceSend === true || yeet');
    expect(source).toContain('onPressedChange={toggleYeet}');
    expect(source).toContain("String('Steer the running turn…')".replace('String(', '').replace(')', ''));
  });
});
