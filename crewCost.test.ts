import { describe, expect, test } from 'bun:test';
import { crewCostLabel, crewCostOf, crewCostState, crewCostTitle } from './src/lib/crewCost';
import type { Session } from './src/types';

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
