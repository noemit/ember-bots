import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { crewCostLabel, crewCostOf, crewCostsByKey, crewCostState, crewCostTitle } from '../src/lib/crewCost';
import { sessionKey, type Session } from '../src/types';

/**
 * The badge at the top of a leader used to show only that conversation's own ledger: measured on
 * this host, $1.07 against $3.87 in its 17 workers, so 78% of the spend read as not existing.
 * These pin the parts that made the sum wrong when it was guessed at: nesting, archived workers,
 * double counting, and the difference between "priced" and "a floor".
 */
const leader = (cost: number | undefined, extra: Partial<Session> = {}): Session => ({
  id: 'lead',
  instanceId: 'hearth',
  title: 'Lead',
  cost,
  ...extra,
});

const worker = (id: string, cost: number | undefined, extra: Partial<Session> = {}): Session => ({
  id,
  instanceId: 'hearth',
  kind: 'worker',
  lead: { instanceId: 'hearth', sessionId: 'lead' },
  title: id,
  cost,
  ...extra,
});

const state = (session: Session, sessions: Session[], hasRun = true) =>
  crewCostState(crewCostOf(session, hasRun, sessions));

describe('the cost of a session and its crew', () => {
  test('adds the workers to the leader, and says which is which', () => {
    const sessions = [leader(1.07), worker('a', 2.5), worker('b', 1.37)];
    const cost = state(sessions[0], sessions);
    expect(cost.kind).toBe('priced');
    if (cost.kind !== 'priced') throw new Error('unreachable');
    expect(cost.own).toBe(1.07);
    expect(cost.crew).toBeCloseTo(3.87, 5);
    expect(cost.total).toBeCloseTo(4.94, 5);
    expect(cost.workers).toBe(2);
    expect(cost.partial).toBe(false);
    expect(crewCostLabel(cost)).toBe('$4.94');
  });

  test('counts the whole tree, not just direct reports', () => {
    // A worker can lead its own workers; the money spent two levels down is still this session's.
    const sessions = [
      leader(1),
      worker('a', 2),
      worker('b', 4, { lead: { instanceId: 'hearth', sessionId: 'a' } }),
      worker('c', 8, { lead: { instanceId: 'hearth', sessionId: 'b' } }),
    ];
    const cost = state(sessions[0], sessions);
    if (cost.kind !== 'priced') throw new Error('unreachable');
    expect(cost.crew).toBe(14);
    expect(cost.workers).toBe(3);
  });

  test('finished and archived workers still count: the money was spent', () => {
    const sessions = [leader(0.5), worker('a', 3, { archived: true })];
    const cost = state(sessions[0], sessions);
    if (cost.kind !== 'priced') throw new Error('unreachable');
    expect(cost.total).toBe(3.5);
  });

  test('a worker is counted once, however the list reached it', () => {
    const sessions = [
      leader(1),
      worker('a', 2),
      // The same conversation, delivered twice (two polls, two instances of the same id).
      worker('a', 2),
      worker('b', 4, { lead: { instanceId: 'hearth', sessionId: 'a' } }),
    ];
    const cost = state(sessions[0], sessions);
    if (cost.kind !== 'priced') throw new Error('unreachable');
    expect(cost.crew).toBe(6);
    expect(cost.workers).toBe(2);
  });

  test('a malformed lead chain cannot loop for ever', () => {
    const sessions = [leader(1), worker('a', 2), worker('lead', 3, { lead: { instanceId: 'hearth', sessionId: 'a' }, id: 'lead2' })];
    const cost = state(sessions[0], sessions);
    if (cost.kind !== 'priced') throw new Error('unreachable');
    // The leader never counts itself, and the walk terminates.
    expect(cost.own).toBe(1);
  });
});

describe('what the badge may claim', () => {
  test('a leader with unpriced turns does not look priced because a worker was', () => {
    // The provider priced the worker and not the leader: the total is a floor, and the badge says so.
    const sessions = [leader(0), worker('a', 3)];
    const cost = state(sessions[0], sessions);
    if (cost.kind !== 'priced') throw new Error('unreachable');
    expect(cost.own).toBeUndefined();
    expect(cost.crew).toBe(3);
    expect(cost.partial).toBe(true);
    expect(crewCostLabel(cost)).toBe('$3.00+');
    expect(crewCostTitle(cost)).toMatch(/floor, not the bill/);
    // The priced part is named; the missing one is not silently omitted.
    expect(crewCostTitle(cost)).toContain('its crew $3.00');
  });

  test('a priced part with an unpriced sibling is still a floor', () => {
    const sessions = [leader(1), worker('a', 2), worker('b', 0)];
    const cost = state(sessions[0], sessions);
    if (cost.kind !== 'priced') throw new Error('unreachable');
    expect(cost.partial).toBe(true);
    expect(crewCostLabel(cost)).toBe('$3.00+');
  });

  test('the tooltip names the parts and the workers', () => {
    const cost = state(leader(1.07), [leader(1.07), worker('a', 3.87)]);
    const title = crewCostTitle(cost);
    expect(title).toContain('$1.07');
    expect(title).toContain('$3.87');
    expect(title).toContain('1 worker');
    expect(title).not.toContain('floor');
  });

  test('nothing ran anywhere: no badge at all', () => {
    expect(state(leader(undefined), [leader(undefined)], false).kind).toBe('none');
  });

  test('everything ran and nothing was priced: unknown, not "$0"', () => {
    const cost = state([leader(0), worker('a', undefined)], [leader(0), worker('a', undefined)]);
    expect(cost.kind).toBe('unknown');
    expect(crewCostLabel(cost)).toBe('');
  });

  test('a crew with no leader turns still prices the family', () => {
    // A leader whose own turn has not run yet, with a worker that has: the total is the worker's,
    // and it is not a floor because the leader has spent nothing.
    const cost = state(leader(undefined), [leader(undefined), worker('a', 2)], false);
    if (cost.kind !== 'priced') throw new Error('unreachable');
    expect(cost.total).toBe(2);
    expect(cost.partial).toBe(false);
    expect(crewCostLabel(cost)).toBe('$2.00');
  });
});

describe('crewCostsByKey batch derivation and O(N) scaling', () => {
  test('matches per-session crewCostOf across nested trees, peers, cycles, duplicates, and unpriced turns', () => {
    const sessions: Session[] = [
      leader(1.25, { id: 'root-1', lastEntryId: 'e1' }),
      worker('w-1', 0.5, { lead: { instanceId: 'hearth', sessionId: 'root-1' }, lastEntryId: 'e2' }),
      worker('w-2', 1.75, { lead: { instanceId: 'hearth', sessionId: 'w-1' }, lastEntryId: 'e3' }),
      worker('w-3', 0, { lead: { instanceId: 'hearth', sessionId: 'w-2' }, lastEntryId: 'e4' }),
      leader(undefined, { id: 'idle-draft' }),
      leader(0, { id: 'unpriced-only', lastEntryId: 'e5' }),
      worker('peer-1', 9, { kind: 'peer', lead: { instanceId: 'hearth', sessionId: 'root-1' }, lastEntryId: 'e6' }),
      // Cycle a <-> b
      worker('cycle-a', 2, { lead: { instanceId: 'hearth', sessionId: 'cycle-b' }, lastEntryId: 'e7' }),
      worker('cycle-b', 3, { lead: { instanceId: 'hearth', sessionId: 'cycle-a' }, lastEntryId: 'e8' }),
    ];
    const hasRun = (s: Session) => s.lastEntryId !== undefined || (typeof s.cost === 'number' && s.cost > 0);
    const batch = crewCostsByKey(sessions, hasRun);
    for (const s of sessions) {
      expect(batch.get(sessionKey(s))).toEqual(crewCostState(crewCostOf(s, hasRun(s), sessions)));
    }

    // Duplicate worker entries in the list also match crewCostOf exactly.
    const withDup: Session[] = [
      leader(1, { lastEntryId: 'e1' }),
      worker('dup', 2, { lastEntryId: 'e2' }),
      worker('dup', 2, { lastEntryId: 'e2' }),
      worker('child', 4, { lead: { instanceId: 'hearth', sessionId: 'dup' }, lastEntryId: 'e3' }),
    ];
    const dupBatch = crewCostsByKey(withDup, hasRun);
    for (const s of withDup) {
      expect(dupBatch.get(sessionKey(s))).toEqual(crewCostState(crewCostOf(s, hasRun(s), withDup)));
    }
  });

  test('scales linearly O(N) across both wide crews and deep nested chains', () => {
    const countPropertyReads = (n: number, mode: 'wide' | 'chain'): number => {
      let reads = 0;
      const track = (raw: Session): Session =>
        new Proxy(raw, {
          get(target, prop, receiver) {
            if (prop === 'lead' || prop === 'kind' || prop === 'cost') reads += 1;
            return Reflect.get(target, prop, receiver);
          },
        });

      const list: Session[] = [];
      if (mode === 'wide') {
        const leaders = Math.max(1, Math.floor(n / 10));
        for (let i = 0; i < leaders; i += 1) {
          list.push(track({ id: `L-${i}`, instanceId: 'hearth', cost: 1, lastEntryId: 'e' }));
        }
        for (let i = leaders; i < n; i += 1) {
          const parentIdx = i % leaders;
          list.push(
            track({
              id: `W-${i}`,
              instanceId: 'hearth',
              kind: 'worker',
              lead: { instanceId: 'hearth', sessionId: `L-${parentIdx}` },
              cost: 0.5,
              lastEntryId: 'e',
            })
          );
        }
      } else {
        list.push(track({ id: 'C-0', instanceId: 'hearth', cost: 1, lastEntryId: 'e' }));
        for (let i = 1; i < n; i += 1) {
          list.push(
            track({
              id: `C-${i}`,
              instanceId: 'hearth',
              kind: 'worker',
              lead: { instanceId: 'hearth', sessionId: `C-${i - 1}` },
              cost: 1,
              lastEntryId: 'e',
            })
          );
        }
      }

      const map = crewCostsByKey(list, () => true);
      expect(map.size).toBe(n);
      if (mode === 'chain') {
        const top = map.get('hearth::C-0');
        expect(top?.kind).toBe('priced');
        if (top?.kind === 'priced') {
          expect(top.total).toBe(n);
          expect(top.workers).toBe(n - 1);
        }
      }
      return reads;
    };

    // 4x input size must do ~4x work (linear O(N)), never ~16x (quadratic O(N^2)).
    for (const mode of ['wide', 'chain'] as const) {
      const reads500 = countPropertyReads(500, mode);
      const reads2000 = countPropertyReads(2000, mode);
      expect(reads2000 / reads500).toBeLessThan(4.5);
      expect(reads2000).toBeLessThan(2000 * 10);
    }

    // Large benchmark: 10,000 sessions complete well within linear budget.
    const large: Session[] = [{ id: 'root', instanceId: 'hearth', cost: 1, lastEntryId: 'e' }];
    for (let i = 1; i < 10_000; i += 1) {
      large.push({
        id: `w-${i}`,
        instanceId: 'hearth',
        kind: 'worker',
        lead: { instanceId: 'hearth', sessionId: i <= 100 ? 'root' : `w-${i - 100}` },
        cost: 0.01,
        lastEntryId: 'e',
      });
    }
    const start = performance.now();
    const largeMap = crewCostsByKey(large, () => true);
    const elapsedMs = performance.now() - start;
    expect(largeMap.size).toBe(10_000);
    const rootCost = largeMap.get('hearth::root');
    expect(rootCost?.kind).toBe('priced');
    if (rootCost?.kind === 'priced') {
      expect(rootCost.workers).toBe(9_999);
      expect(rootCost.total).toBeCloseTo(1 + 9_999 * 0.01, 5);
    }
    expect(elapsedMs).toBeLessThan(250);
  });

  test('useSessionSelectors derives crewCostByKey via crewCostsByKey rather than per-session crewCostOf', () => {
    const selectorsSource = fs.readFileSync(path.join(import.meta.dir, '../src/app/useSessionSelectors.ts'), 'utf8');
    expect(selectorsSource).toContain('crewCostsByKey(');
    expect(selectorsSource).not.toContain('crewCostOf(');
    const appSource = fs.readFileSync(path.join(import.meta.dir, '../src/App.tsx'), 'utf8');
    expect(appSource).not.toContain('crewCostOf(');
  });
});
