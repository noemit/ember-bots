import { describe, expect, test } from 'bun:test';
import { splitSnoozedRail } from '../src/lib/snoozedRail';
import { buildRailEntries, groupDraftFromEntry } from '../src/lib/projectGroups';
import { sessionKey, type Session } from '../src/types';

const a: Session = { id: 'a', instanceId: 'local', directory: '/work/app', updated: 10 };
const b: Session = { ...a, id: 'b', updated: 20 };
const snoozed = new Set([sessionKey(a)]);

describe('snoozed rail placement', () => {
  test('moves individual sessions, leaving a partial project and its open payload intact', () => {
    const placement = splitSnoozedRail([a, b], [a, b], snoozed, null, false);
    const entries = buildRailEntries(placement.main, { local: [{ id: 'app', name: 'App', path: '/work/app' }] });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('project');
    if (entries[0].kind !== 'project') throw new Error('Expected a project');
    expect(entries[0].sessions).toEqual([b]);
    expect(placement.snoozed).toEqual([a]);
    expect(a.archived).toBeUndefined();
  });

  test('keeps older snoozed sessions reachable and deduplicates across pools and instances', () => {
    const remote = { ...a, instanceId: 'remote' };
    const placement = splitSnoozedRail([b], [a, a, remote], snoozed, null, false);
    expect(placement.snoozed).toEqual([a]);
    expect(placement.main).toEqual([b]);
  });

  test('never surfaces hidden sessions or workers in either pool', () => {
    const hidden = { ...a, id: 'hidden', archived: 1 };
    const worker = { ...a, id: 'worker', kind: 'worker' as const };
    const keys = new Set([sessionKey(hidden), sessionKey(worker)]);
    expect(splitSnoozedRail([hidden, worker], [hidden, worker], keys, sessionKey(worker), false)).toEqual({ main: [], snoozed: [] });
  });

  test('selection does not unsnooze: pin on mobile, leave desktop dock visible', () => {
    expect(splitSnoozedRail([a, b], [a, b], snoozed, sessionKey(a), false).main).toEqual([a, b]);
    expect(splitSnoozedRail([a, b], [a, b], snoozed, sessionKey(a), true).main).toEqual([b]);
    expect(splitSnoozedRail([a, b], [a, b], snoozed, sessionKey(a), true).snoozed).toEqual([a]);
    expect(snoozed.has(sessionKey(a))).toBe(true);
  });

  test('group display excludes snoozed members without rewriting configured membership', () => {
    const group = { id: 'g', name: 'Work', keys: [sessionKey(a), sessionKey(b)], primaryKey: sessionKey(a) };
    const placement = splitSnoozedRail([a, b], [a, b], snoozed, null, false);
    const entries = buildRailEntries(placement.main, {}, [group]);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('group');
    if (entries[0].kind !== 'group') throw new Error('Expected a group');
    expect(entries[0].members).toEqual([b]);
    expect(groupDraftFromEntry(entries[0]).keys).toEqual(group.keys);
    expect(groupDraftFromEntry(entries[0]).primaryKey).toBe(sessionKey(a));
  });
});
