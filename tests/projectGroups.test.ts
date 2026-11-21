import { describe, expect, test } from 'bun:test';
import {
  blobStripLayout,
  buildRailEntries,
  nextSessionAfterArchive,
  notesKeyForSession,
} from '../src/lib/projectGroups';
import { sessionKey } from '../src/types';
import type { Project, Session } from '../src/types';

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
      sessionKey(nextSessionAfterArchive(a, [a, b, c], projects, new Set(['local::b'])) ?? a)
    ).toBe('local::c');
    // Everything else is minimized: a minimized one beats an empty workspace.
    expect(
      sessionKey(nextSessionAfterArchive(a, [a, b], projects, new Set(['local::b'])) ?? a)
    ).toBe('local::b');
  });

  test('returns null when the rail has nothing left, so Home is the honest answer', () => {
    const a = at('a', '/work/habit', 900);
    expect(nextSessionAfterArchive(a, [a], projects)).toBeNull();
  });
});
