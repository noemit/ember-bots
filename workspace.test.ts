import { describe, expect, test } from 'bun:test';
import {
  formatSessionKey,
  MAX_OPEN_SESSIONS,
  numberShortcutSlot,
  parseSessionKey,
  pruneTranscripts,
  pruneWorkspace,
  transcriptKeysToKeep,
  visibleColumns,
} from './src/lib/workspace';

describe('workspace session keys', () => {
  test('round-trips instance and session ids', () => {
    const ref = { instanceId: 'local', sessionId: 'ses_123' };
    expect(parseSessionKey(formatSessionKey(ref))).toEqual(ref);
    expect(formatSessionKey(ref)).toBe('local::ses_123');
    // A session id containing the separator still parses (first separator wins).
    expect(parseSessionKey('local::ses::weird')).toEqual({ instanceId: 'local', sessionId: 'ses::weird' });
  });

  test('rejects malformed keys', () => {
    expect(parseSessionKey(null)).toBeNull();
    expect(parseSessionKey('')).toBeNull();
    expect(parseSessionKey('noseparator')).toBeNull();
    expect(parseSessionKey('::session')).toBeNull();
    expect(parseSessionKey('instance::')).toBeNull();
  });
});

describe('visible columns', () => {
  const open = ['a', 'b', 'c', 'd'];

  test('without split view there is exactly one column: the active session', () => {
    // The default. Opening another session takes the view over rather than adding a column, so
    // what is open decides nothing about what is drawn.
    expect(visibleColumns('c', open, 1000)).toEqual(['c']);
    expect(visibleColumns('c', open, 0)).toEqual(['c']);
  });

  test('without split view and with nothing active the first open session stands in', () => {
    expect(visibleColumns(null, open, 1000)).toEqual(['a']);
  });

  test('without anything open there is no column at all', () => {
    expect(visibleColumns('c', [], 1000)).toEqual([]);
  });

  test('split view caps by width but always shows at least one', () => {
    expect(visibleColumns('a', open, 1000, { splitView: true, minWidth: 420 })).toEqual(['a', 'b']);
    expect(visibleColumns('a', open, 420, { splitView: true, minWidth: 420 })).toEqual(['a']);
    expect(visibleColumns('a', open, 100, { splitView: true, minWidth: 420 })).toEqual(['a']);
    // No measured width yet: show what is open rather than hiding half of it.
    expect(visibleColumns('a', open, 0, { splitView: true, minWidth: 420 })).toEqual(open);
  });

  test('split view puts the active session first, so a click never opens off screen', () => {
    // Four open, two fit: the active one must be one of them even though it is last in open order.
    expect(visibleColumns('d', open, 900, { splitView: true, minWidth: 420 })).toEqual(['d', 'a']);
  });
});

describe('workspace pruning', () => {
  test('drops keys whose session is archived, missing, or unparseable', () => {
    const sessions: Record<string, string[]> = { local: ['a', 'b'], remote: ['x'] };
    const check = (ref: { instanceId: string; sessionId: string }) =>
      sessions[ref.instanceId]?.includes(ref.sessionId) ?? undefined;

    expect(
      pruneWorkspace(
        {
          open: ['local::a', 'local::gone', 'broken', 'remote::x', 'remote::y'],
          active: 'local::a',
          minimized: ['local::gone', 'remote::y'],
        },
        check
      )
    ).toEqual({
      open: ['local::a', 'remote::x'],
      active: 'local::a',
      minimized: [],
    });
  });

  test('keeps unknown instances and sessions while lists load, and a null draft active', () => {
    const check = () => undefined;
    expect(
      pruneWorkspace(
        { open: ['local::a'], active: null, minimized: ['local::a'] },
        check
      )
    ).toEqual({ open: ['local::a'], active: null, minimized: ['local::a'] });
  });

  test('re-points active at the first open non-minimized session when it is gone', () => {
    const check = (ref: { instanceId: string; sessionId: string }) => ref.sessionId !== 'old';
    expect(
      pruneWorkspace(
        { open: ['local::old', 'local::b', 'local::c'], active: 'local::old', minimized: ['local::b'] },
        check
      )
    ).toEqual({ open: ['local::b', 'local::c'], active: 'local::c', minimized: ['local::b'] });
  });

  test('caps the open list', () => {
    const open = Array.from({ length: MAX_OPEN_SESSIONS + 3 }, (_, index) => `local::s${index}`);
    const pruned = pruneWorkspace({ open, active: open[0], minimized: [] }, () => true);
    expect(pruned.open).toHaveLength(MAX_OPEN_SESSIONS);
    expect(pruned.open[0]).toBe('local::s0');
    expect(pruned.open.at(-1)).toBe(`local::s${MAX_OPEN_SESSIONS - 1}`);
  });
});

describe('number shortcuts', () => {
  const event = (overrides: Partial<Parameters<typeof numberShortcutSlot>[0]>) => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: '',
    ...overrides,
  });

  test('maps Cmd/Ctrl+1-9 to a 0-based slot', () => {
    expect(numberShortcutSlot(event({ metaKey: true, key: '1' }))).toBe(0);
    expect(numberShortcutSlot(event({ ctrlKey: true, key: '5' }))).toBe(4);
    expect(numberShortcutSlot(event({ metaKey: true, key: '9' }))).toBe(8);
  });

  test('ignores other modifiers, non-digits and unmodified digits', () => {
    expect(numberShortcutSlot(event({ key: '3' }))).toBeNull();
    expect(numberShortcutSlot(event({ metaKey: true, shiftKey: true, key: '3' }))).toBeNull();
    expect(numberShortcutSlot(event({ metaKey: true, altKey: true, key: '3' }))).toBeNull();
    expect(numberShortcutSlot(event({ metaKey: true, key: '0' }))).toBeNull();
    expect(numberShortcutSlot(event({ metaKey: true, key: 'a' }))).toBeNull();
    expect(numberShortcutSlot(event({ metaKey: true, key: 'Enter' }))).toBeNull();
  });
});

describe('transcript pruning', () => {
  test('keeps open sessions, cached keys and the active session', () => {
    const keep = transcriptKeysToKeep(['a', 'b'], ['b', 'c'], 'd');
    expect([...keep].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  test('tolerates a null active session and duplicate keys', () => {
    const keep = transcriptKeysToKeep(['a', 'a'], ['a'], null);
    expect([...keep]).toEqual(['a']);
  });

  test('drops unkept entries and returns the input unchanged when nothing would drop', () => {
    const transcripts = { a: 1, b: 2, c: 3 };
    expect(pruneTranscripts(transcripts, new Set(['a', 'b', 'c']))).toBe(transcripts);
    const pruned = pruneTranscripts(transcripts, new Set(['b']));
    expect(pruned).toEqual({ b: 2 });
    expect(pruned).not.toBe(transcripts);
  });
});

describe('pruning against a half-started instance', () => {
  test('an empty list is not proof a session is gone, so the workspace survives startup', () => {
    // Hearth answers with nothing while it boots; treating that as authoritative used to erase the
    // user's open columns and persist the loss.
    const check = (list: string[]) => (ref: { instanceId: string; sessionId: string }) =>
      list.length === 0 ? undefined : list.includes(ref.sessionId);
    const workspace = { open: ['local::a', 'local::b'], active: 'local::a', minimized: [] };
    const survived = pruneWorkspace(workspace, check([]));
    expect(survived).toEqual(workspace);
    const pruned = pruneWorkspace(workspace, check(['b']));
    expect(pruned.open).toEqual(['local::b']);
    expect(pruned.active).toBe('local::b');
  });
});
