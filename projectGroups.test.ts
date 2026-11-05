import { describe, expect, test } from 'bun:test';
import {
  blobStripLayout,
  buildRailEntries,
  groupDraftFromEntry,
  nextSessionAfterArchive,
  notesKeyForSession,
} from './src/lib/projectGroups';
import { sessionKey } from './src/types';
import type { Project, Session } from './src/types';

const session = (overrides: Partial<Session> & Pick<Session, 'id'>): Session => ({
  instanceId: 'local',
  ...overrides,
});

const projects: Record<string, Project[]> = {
  local: [
    { id: 'p1', name: 'Habit', path: '/work/habit' },
    { id: 'p2', name: 'Ember', path: '/work/ember' },
  ],
  remote: [{ id: 'p3', name: 'Studio', path: '/srv/studio' }],
};

describe('buildRailEntries', () => {
  test('groups configured-project sessions and leaves the rest standalone', () => {
    const entries = buildRailEntries(
      [
        session({ id: 'a', directory: '/work/habit', updated: 100 }),
        session({ id: 'b', directory: '/work/habit/src', updated: 300 }),
        session({ id: 'c', directory: '/tmp/scratch', updated: 200 }),
      ],
      projects
    );

    const habit = entries.find((entry) => entry.kind === 'project' && entry.project.id === 'p1');
    expect(habit?.kind).toBe('project');
    if (habit?.kind !== 'project') throw new Error('expected habit project');
    expect(habit.sessions.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(habit.updated).toBe(300);

    // The configured project with no sessions (Ember) is absent.
    expect(entries.map((entry) => entry.id)).toEqual(['project:local::p1', 'local::c']);
  });

  test('puts a fork in the source project (same directory)', () => {
    const entries = buildRailEntries(
      [
        session({ id: 'source', directory: '/work/habit', updated: 100 }),
        session({ id: 'fork', directory: '/work/habit', updated: 400, parentId: undefined }),
      ],
      projects
    );
    const habit = entries.find((entry) => entry.kind === 'project' && entry.project.id === 'p1');
    if (habit?.kind !== 'project') throw new Error('expected habit project');
    expect(habit.sessions.map((entry) => entry.id)).toEqual(['fork', 'source']);
  });

  test('interleaves project cards and standalone rows by recency', () => {
    const entries = buildRailEntries(
      [
        session({ id: 'standalone', directory: '/tmp/x', updated: 500 }),
        session({ id: 'habit', directory: '/work/habit', updated: 300 }),
        session({ id: 'ember', directory: '/work/ember', updated: 400 }),
      ],
      projects
    );
    expect(entries.map((entry) => entry.id)).toEqual([
      'local::standalone',
      'project:local::p2',
      'project:local::p1',
    ]);
  });

  test('omits configured projects that own no sessions', () => {
    expect(buildRailEntries([], projects)).toEqual([]);
    expect(
      buildRailEntries([], { local: [{ id: 'nopath', name: 'No path' }, { id: 'empty', name: 'Empty', path: '/work/empty' }] })
    ).toEqual([]);
  });

  test('binds notes to the session, even inside a configured project', () => {
    const keyFor = (value: Session) => notesKeyForSession(value);
    // Two sessions in the same project no longer share a notes bucket…
    expect(keyFor(session({ id: 'a', directory: '/work/habit' }))).toBe('local::a');
    expect(keyFor(session({ id: 'b', directory: '/work/habit/src' }))).toBe('local::b');
    // …and a standalone session is unaffected.
    expect(keyFor(session({ id: 'c', directory: '/tmp/x' }))).toBe('local::c');
  });
});

describe('blobStripLayout', () => {
  test('renders small counts at full size', () => {
    expect(blobStripLayout(0, 280)).toEqual({ size: 30, visible: 0, overflow: 0 });
    expect(blobStripLayout(3, 280)).toEqual({ size: 30, visible: 3, overflow: 0 });
    expect(blobStripLayout(4, 280)).toEqual({ size: 30, visible: 4, overflow: 0 });
  });

  test('shrinks as the count grows', () => {
    expect(blobStripLayout(5, 280).size).toBe(28);
    expect(blobStripLayout(10, 280).size).toBe(18);
    expect(blobStripLayout(40, 280).size).toBe(18);
  });

  test('falls back to a +N chip when the minimum size no longer fits', () => {
    const layout = blobStripLayout(20, 280);
    expect(layout.size).toBe(18);
    expect(layout.overflow).toBe(9);
    expect(layout.visible).toBe(11);
  });

  test('reduces the visible count in a narrow strip', () => {
    expect(blobStripLayout(6, 100)).toEqual({ size: 26, visible: 2, overflow: 4 });
  });
});

describe('groups in the rail', () => {
  const project = (id: string) => ({ id, name: id, path: `/work/${id}` });
  const inProject = (id: string, instanceId = 'local'): Session => ({
    id,
    instanceId,
    directory: '/work/habit',
    updated: 100,
  });
  const projectsByInstance = { local: [{ ...project('habit'), path: '/work/habit' }], studio: [] };

  test('a grouped session leaves its project card and appears only in the group', () => {
    const a = inProject('a');
    const b = inProject('b');
    const groups = [{ id: 'g', name: 'Release train', keys: ['local::a', 'studio::c'] }];
    const entries = buildRailEntries([a, b, inProject('c', 'studio')], projectsByInstance, groups);
    const card = entries.find((entry) => entry.kind === 'project');
    expect(card && card.kind === 'project' ? card.sessions.map((session) => session.id) : []).toEqual(['b']);
    const group = entries.find((entry) => entry.kind === 'group');
    expect(group && group.kind === 'group' ? group.members.map((s) => s.id) : []).toEqual(['a', 'c']);
    expect(group && group.kind === 'group' ? group.instanceIds.sort() : []).toEqual(['local', 'studio']);
  });

  test('a group whose members are all absent produces no entry', () => {
    const entries = buildRailEntries([], projectsByInstance, [
      { id: 'g', name: 'Gone', keys: ['local::x', 'local::y'] },
    ]);
    expect(entries).toEqual([]);
  });

  test('keeps every configured key, including members that do not resolve', () => {
    // `b` and `c` are not in the loaded session list: one is a session outside the window, the
    // other sits on an instance that is not answering. The group still owns all three keys.
    const groups = [
      {
        id: 'g',
        name: 'Release train',
        keys: ['local::a', 'local::b', 'studio::c'],
        primaryKey: 'studio::c',
      },
    ];
    const entries = buildRailEntries([inProject('a')], projectsByInstance, groups);
    const entry = entries.find((candidate) => candidate.kind === 'group');
    if (entry?.kind !== 'group') throw new Error('expected a group entry');
    expect(entry.keys).toEqual(['local::a', 'local::b', 'studio::c']);
    expect(entry.members.map((member) => member.id)).toEqual(['a']);
    // The configured primary survives even though it cannot resolve, so an outage cannot re-point
    // where a new agent starts.
    expect(entry.primaryKey).toBe('studio::c');
  });

  test('the Manage draft carries the configured keys, not the resolved members', () => {
    const groups = [
      { id: 'g', name: 'Release train', keys: ['local::a', 'local::b', 'studio::c'] },
    ];
    const entries = buildRailEntries([inProject('a')], projectsByInstance, groups);
    const entry = entries.find((candidate) => candidate.kind === 'group');
    if (entry?.kind !== 'group') throw new Error('expected a group entry');
    const draft = groupDraftFromEntry(entry);
    expect(draft.keys).toEqual(['local::a', 'local::b', 'studio::c']);
    expect(draft).toMatchObject({ id: 'g', name: 'Release train' });
    // Rebuilding the draft from `members` is the bug this guards: it would save two keys back and
    // drop the member the instance could not answer for.
    expect(entry.members.map(sessionKey)).not.toEqual(draft.keys);
  });

  test('a primary that is no longer configured falls back to the most recent member', () => {
    const groups = [{ id: 'g', name: 'G', keys: ['local::a', 'local::b'], primaryKey: 'local::gone' }];
    const entries = buildRailEntries(
      [{ ...inProject('a'), updated: 10 }, { ...inProject('b'), updated: 20 }],
      projectsByInstance,
      groups
    );
    const entry = entries.find((candidate) => candidate.kind === 'group');
    if (entry?.kind !== 'group') throw new Error('expected a group entry');
    expect(entry.primaryKey).toBe('local::b');
  });

  test('groups and projects interleave by recency, newest first', () => {
    const older = { ...inProject('a'), updated: 10 };
    const newer = { ...inProject('b'), updated: 900 };
    const groups = [{ id: 'g', name: 'Group', keys: ['local::a', 'local::c'] }];
    const entries = buildRailEntries(
      [older, newer, { ...inProject('c'), updated: 10 }],
      projectsByInstance,
      groups
    );
    expect(entries.map((entry) => entry.kind)).toEqual(['project', 'group']);
  });
});

describe('the session to show after archiving one', () => {
  const project = (id: string, name: string, path: string): Project => ({ id, name, path });
  const projects: Record<string, Project[]> = { local: [project('p1', 'Habit', '/work/habit'), project('p2', 'Ember', '/work/ember')] };
  const at = (id: string, directory: string, updated: number, extra: Partial<Session> = {}): Session => ({
    id,
    instanceId: 'local',
    directory,
    title: id,
    updated,
    ...extra,
  });

  test('takes the next session down the rail when the last column is archived', () => {
    const a = at('a', '/work/habit', 900);
    const b = at('b', '/work/habit', 800);
    const c = at('c', '/work/ember', 700);
    const sessions = [a, b, c];
    // "a" is the newest, so the rail reads a, b, c; archiving "a" hands over to "b".
    expect(sessionKey(nextSessionAfterArchive(a, sessions, projects) ?? a)).toBe('local::b');
    expect(sessionKey(nextSessionAfterArchive(b, sessions, projects) ?? b)).toBe('local::c');
    // The last one wraps to the top rather than leaving the workspace empty.
    expect(sessionKey(nextSessionAfterArchive(c, sessions, projects) ?? c)).toBe('local::a');
  });

  test('skips sessions that cannot be read: archived rows and crew workers', () => {
    const a = at('a', '/work/habit', 900);
    const gone = at('gone', '/work/habit', 850, { archived: 1 });
    const worker = at('worker', '/work/habit', 840, { kind: 'worker' });
    const b = at('b', '/work/habit', 800);
    const next = nextSessionAfterArchive(a, [a, gone, worker, b], projects);
    expect(sessionKey(next ?? a)).toBe('local::b');
  });

  test('prefers a session that is not a minimized tab, until nothing else is left', () => {
    const a = at('a', '/work/habit', 900);
    const b = at('b', '/work/habit', 800);
    const c = at('c', '/work/ember', 700);
    expect(
      sessionKey(nextSessionAfterArchive(a, [a, b, c], projects, [], new Set(['local::b'])) ?? a)
    ).toBe('local::c');
    // Everything else is minimized: a minimized one beats an empty workspace.
    expect(
      sessionKey(nextSessionAfterArchive(a, [a, b], projects, [], new Set(['local::b'])) ?? a)
    ).toBe('local::b');
  });

  test('returns null when the rail has nothing left, so Home is the honest answer', () => {
    const a = at('a', '/work/habit', 900);
    expect(nextSessionAfterArchive(a, [a], projects)).toBeNull();
  });

  test('a group member hands over within its group first (the rail order)', () => {
    const a = at('a', '/work/habit', 900);
    const b = at('b', '/work/habit', 800);
    const c = at('c', '/work/ember', 700);
    const groups = [{ id: 'g1', name: 'Release train', keys: ['local::c', 'local::a', 'local::b'] }];
    // All three are in one group, so the group's own order decides.
    const next = nextSessionAfterArchive(a, [a, b, c], projects, groups);
    expect(['local::b', 'local::c']).toContain(sessionKey(next ?? a));
    expect(sessionKey(next ?? a)).not.toBe('local::a');
  });
});
