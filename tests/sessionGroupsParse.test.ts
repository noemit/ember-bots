import { describe, expect, test } from 'bun:test';
import { parseSessionGroups } from '../electron/transport';

/**
 * The groups parser is defensive because settings.json is shared with the macOS app and can be
 * hand-edited: it must never produce a key in two groups, a group with one member, or a primary that
 * is not a member.
 */
describe('parseSessionGroups', () => {
  test('keeps well-formed groups and resolves the primary to a real member', () => {
    const groups = parseSessionGroups([
      { id: 'g', name: 'Release train', keys: ['local::a', 'studio::b'], primaryKey: 'studio::b' },
    ]);
    expect(groups).toEqual([
      { id: 'g', name: 'Release train', keys: ['local::a', 'studio::b'], primaryKey: 'studio::b' },
    ]);
    // A primary that is not a member falls back to the first key.
    expect(parseSessionGroups([{ id: 'g', name: 'n', keys: ['a::1', 'a::2'], primaryKey: 'x::9' }])[0].primaryKey).toBe('a::1');
  });

  test('drops malformed entries and groups below two members', () => {
    expect(
      parseSessionGroups([
        null,
        'nope',
        { id: 'no-keys', name: 'x' },
        { id: 'one', name: 'x', keys: ['local::a'] },
        { name: 'no id', keys: ['local::a', 'local::b'] },
      ])
    ).toEqual([]);
  });

  test('a key appears in one group only, and duplicate ids are dropped', () => {
    const groups = parseSessionGroups([
      { id: 'a', name: 'A', keys: ['local::1', 'local::2'] },
      { id: 'b', name: 'B', keys: ['local::1', 'local::3'] },
      { id: 'a', name: 'A again', keys: ['local::4', 'local::5'] },
    ]);
    const keys = groups.flatMap((group) => group.keys);
    expect(new Set(keys).size).toBe(keys.length);
    // 'b' loses its only unique key to the de-dupe, which leaves it with one member, so it is
    // dropped rather than allowed to hold a duplicate. Sharing a key silently loses the later group.
    expect(groups.map((group) => group.id)).toEqual(['a']);
  });

  test('rejects anything that is not a list', () => {
    expect(parseSessionGroups(undefined)).toEqual([]);
    expect(parseSessionGroups({ id: 'g' })).toEqual([]);
  });
});
