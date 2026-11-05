import { describe, expect, test } from 'bun:test';
import {
  addToGroup,
  canSaveGroup,
  createGroup,
  defaultGroupName,
  groupForSession,
  groupMissingNote,
  MAX_GROUP_MEMBERS,
  missingGroupMembers,
  pruneGroups,
  removeFromGroup,
  setGroupPrimary,
  upsertGroup,
  type SessionGroup,
} from './src/lib/sessionGroups';

const group = (id: string, keys: string[], extra: Partial<SessionGroup> = {}): SessionGroup => ({
  id,
  name: id,
  keys,
  ...extra,
});

describe('session groups', () => {
  test('a session belongs to at most one group, so adding it to another moves it', () => {
    // Three members in `a`, so moving one leaves it a legal group of two.
    const groups = [group('a', ['local::1', 'local::2', 'local::5']), group('b', ['local::3', 'local::4'])];
    const next = addToGroup(groups, 'b', ['local::1']);
    expect(groupForSession(next, 'local::1')?.id).toBe('b');
    expect(next.find((entry) => entry.id === 'a')?.keys).toEqual(['local::2', 'local::5']);

    // Moving one member out of a two-member group dissolves the group it left.
    const two = addToGroup([group('a', ['local::1', 'local::2']), group('b', ['local::3', 'local::4'])], 'b', ['local::1']);
    expect(two.find((entry) => entry.id === 'a')).toBeUndefined();
  });

  test('a group that falls below two members is dissolved', () => {
    const groups = [group('a', ['local::1', 'local::2'])];
    expect(removeFromGroup(groups, 'a', ['local::2'])).toEqual([]);
    const three = [group('a', ['local::1', 'local::2', 'studio::3'])];
    const kept = removeFromGroup(three, 'a', ['local::2']);
    expect(kept).toHaveLength(1);
    expect(kept[0].keys).toEqual(['local::1', 'studio::3']);
  });

  test('keys are unique and capped, and creation moves members out of other groups', () => {
    const many = Array.from({ length: MAX_GROUP_MEMBERS + 5 }, (_, i) => `local::${i}`);
    const created = createGroup([group('a', ['local::0', 'local::1'])], {
      id: 'b',
      name: 'B',
      keys: [...many, many[0]],
    });
    const b = created.find((entry) => entry.id === 'b');
    expect(b?.keys).toHaveLength(MAX_GROUP_MEMBERS);
    expect(new Set(b?.keys).size).toBe(MAX_GROUP_MEMBERS);
    expect(created.find((entry) => entry.id === 'a')).toBeUndefined();
  });

  test('pruning keeps groups with unknown members and never leaves a key in two groups', () => {
    const groups = [
      group('a', ['local::gone', 'local::keep', 'local::unknown']),
      group('b', ['local::keep', 'studio::1', 'studio::2']),
    ];
    const next = pruneGroups(groups, (key) =>
      key === 'local::gone' ? false : key === 'local::unknown' ? undefined : true
    );
    const all = next.flatMap((entry) => entry.keys);
    expect(new Set(all).size).toBe(all.length);
    expect(next.flatMap((entry) => entry.keys)).not.toContain('local::gone');
    // `unknown` survives, and `keep` stays only in the first group.
    expect(next[0].keys).toEqual(['local::keep', 'local::unknown']);
    expect(next[1].keys).not.toContain('local::keep');
  });

  test('the primary member falls back when it is removed', () => {
    const groups = [group('a', ['local::1', 'local::2', 'local::3'], { primaryKey: 'local::3' })];
    const moved = removeFromGroup(groups, 'a', ['local::3']);
    expect(moved[0].primaryKey).toBe('local::1');
    const pinned = setGroupPrimary([group('a', ['local::1', 'local::2'])], 'a', 'local::2');
    expect(pinned[0].primaryKey).toBe('local::2');
  });

  test('default names use the first two titles and count the rest', () => {
    expect(defaultGroupName([])).toBe('Group');
    // One member is *not* named after itself: a group made from one session's "Group with..." used
    // to carry that session's title, so the card's header repeated the one name in its list.
    expect(defaultGroupName(['Parse config'])).toBe('Group');
    expect(defaultGroupName(['Parse config', 'Migrate schema'])).toBe('Parse config + Migrate schema');
    expect(defaultGroupName(['A', 'B', 'C', 'D'])).toBe('A + B +2');
  });

  test('upsertGroup moves members out of other groups on both create and edit', () => {
    const initial = [group('g1', ['local::a', 'local::b'])];
    const afterCreate = upsertGroup(initial, {
      id: 'g2',
      name: 'Two',
      keys: ['local::a', 'local::c', 'local::a'],
      primaryKey: 'local::c',
    });
    expect(afterCreate).toEqual([
      {
        id: 'g2',
        name: 'Two',
        keys: ['local::a', 'local::c'],
        primaryKey: 'local::c',
      },
    ]);

    const twoGroups = [
      group('g1', ['local::a', 'local::b', 'local::d']),
      group('g2', ['local::c', 'local::e']),
    ];
    const afterEdit = upsertGroup(twoGroups, {
      id: 'g2',
      name: 'Two edited',
      keys: ['local::c', 'local::e', 'local::a'],
      primaryKey: 'local::a',
    });
    expect(afterEdit).toEqual([
      {
        id: 'g1',
        name: 'g1',
        keys: ['local::b', 'local::d'],
        primaryKey: 'local::b',
      },
      {
        id: 'g2',
        name: 'Two edited',
        keys: ['local::c', 'local::e', 'local::a'],
        primaryKey: 'local::a',
      },
    ]);
  });
});


describe('members a group cannot show right now', () => {
  // Local answers; Tower is listed but not answering; `gone` is not listed at all.
  const instances: Record<string, { label: string; readable: boolean }> = {
    local: { label: 'Local', readable: true },
    tower: { label: 'Tower', readable: false },
  };
  const instanceFor = (instanceId: string) => instances[instanceId];
  const resolved = new Set(['local::a']);
  const missing = (keys: string[]) => missingGroupMembers(keys, (key) => resolved.has(key), instanceFor);

  test('every configured key comes back, with what Ember knows about its instance', () => {
    expect(missing(['local::a', 'tower::b', 'gone::c', 'local::z'])).toEqual([
      { key: 'tower::b', instanceLabel: 'Tower', instanceReadable: false },
      // An instance Ember no longer lists has no label: its next step is "re-add", not "reconnect".
      { key: 'gone::c', instanceLabel: null, instanceReadable: false },
      // A readable instance with no such session is a third case, not an outage.
      { key: 'local::z', instanceLabel: 'Local', instanceReadable: true },
    ]);
  });

  test('the note names the instance, says the place is kept, and points at the fix', () => {
    const offline = groupMissingNote(missing(['tower::b']));
    expect(offline).not.toBeNull();
    // Qualities, not wording: the actor is named…
    expect(offline).toContain('Tower');
    // …the reader is told what it means for their group…
    expect(offline).toMatch(/place is kept/);
    // …and there is a next step that exists in this app.
    expect(offline).toMatch(/Reconnect/);
    expect(offline).toContain('Settings → Instances');
    // Copy rules: no jargon, no stray values, no shouting.
    expect(offline).not.toMatch(/undefined|null|NaN|error|invalid|!/i);
  });

  test('a member on an instance Ember no longer lists is told to re-add it', () => {
    const note = groupMissingNote(missing(['gone::c']));
    expect(note).toContain('no longer lists');
    expect(note).toMatch(/Re-add/);
    expect(note).toContain('Settings → Instances');
    expect(note).not.toMatch(/Reconnect/);
  });

  test('a session missing from an instance that is answering is not called an outage', () => {
    const note = groupMissingNote(missing(['local::z']));
    expect(note).toContain("Local's session list");
    expect(note).toMatch(/place is kept/);
    expect(note).not.toMatch(/Reconnect|Re-add|connected/);
  });

  test('several missing members read as one sentence each, and none is null', () => {
    expect(groupMissingNote([])).toBeNull();
    const two = groupMissingNote(missing(['tower::b', 'tower::d']));
    expect(two).toContain('2 members are on Tower');
    const mixed = groupMissingNote(missing(['tower::b', 'gone::c', 'local::z']));
    expect(mixed).toContain('Tower');
    expect(mixed).toContain('no longer lists');
    expect(mixed).toContain('Local');
  });

  test('the save rule counts configured keys, not the ones that resolve', () => {
    // Both keys are unresolvable; the group is still a legal group, so Save must not be blocked.
    expect(canSaveGroup(['tower::b', 'gone::c'])).toBe(true);
    expect(canSaveGroup(['tower::b'])).toBe(false);
    expect(canSaveGroup([])).toBe(false);
  });
});
