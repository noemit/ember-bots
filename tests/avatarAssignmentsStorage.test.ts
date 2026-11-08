import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AVATAR_COLOR_COUNT } from '../electron/avatarPalette';
import { mergeAvatarAssignments, parseAvatarAssignments } from '../electron/transport';

const original = { colorIndex: 0, shapeSeed: 'host::chat' };

test('assignment parsing validates safe keys and complete palette identities', () => {
  const input = JSON.parse('{"__proto__":{"colorIndex":0,"shapeSeed":"unsafe"}}');
  Object.assign(input, {
    valid: { ...original, extra: 'dropped' },
    constructor: original,
    prototype: original,
    '': original,
    ['k'.repeat(501)]: original,
    missing: { colorIndex: 0 },
    fractional: { ...original, colorIndex: 0.5 },
    negative: { ...original, colorIndex: -1 },
    outside: { ...original, colorIndex: AVATAR_COLOR_COUNT },
    numericString: { ...original, colorIndex: '0' },
    empty: { ...original, shapeSeed: '' },
    blank: { ...original, shapeSeed: ' ' },
    long: { ...original, shapeSeed: 's'.repeat(501) },
    last: { colorIndex: AVATAR_COLOR_COUNT - 1, shapeSeed: 's'.repeat(500) },
    ['k'.repeat(500)]: original,
  });
  expect(parseAvatarAssignments(input)).toEqual({
    valid: original,
    last: input.last,
    ['k'.repeat(500)]: original,
  });
  for (const value of [null, undefined, 42, 'bad', [original]]) {
    expect(parseAvatarAssignments(value)).toEqual({});
  }
});

test('stale client patches append identities without replacing or deleting saved assignments', () => {
  const first = mergeAvatarAssignments({}, { chat: original });
  const second = mergeAvatarAssignments(first, {
    chat: { colorIndex: 1, shapeSeed: 'competing-client' },
    next: { colorIndex: 2, shapeSeed: 'next' },
  });
  expect(second).toEqual({ chat: original, next: { colorIndex: 2, shapeSeed: 'next' } });
  expect(mergeAvatarAssignments(second, {})).toEqual(second);
  expect(mergeAvatarAssignments(second, { chat: null })).toEqual(second);
});

test('disk roundtrip preserves assignments beyond other settings map caps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-avatar-assignments-'));
  try {
    const assignments = Object.fromEntries(Array.from({ length: 2501 }, (_, index) => [
      `host::chat-${index}`, { colorIndex: index % AVATAR_COLOR_COUNT, shapeSeed: `shape-${index}` },
    ]));
    const file = join(directory, 'settings.json');
    await writeFile(file, JSON.stringify({ avatarAssignments: parseAvatarAssignments(assignments) }));
    const restored = parseAvatarAssignments(JSON.parse(await readFile(file, 'utf8')).avatarAssignments);
    expect(restored).toEqual(assignments);
    expect(mergeAvatarAssignments(restored, { 'host::chat-2500': original })).toEqual(assignments);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
