import { describe, expect, test } from 'bun:test';
import { moodFrom } from '../src/blob/mood';
import { crewByLeader } from '../src/lib/crew';
import {
  CREW_PHASE_BUFFER_MS,
  crewAppearanceMood,
  crewActivityPhase,
  nextCrewPhaseDelayMs,
  resolveCrewMoods,
  shouldAlternateCrew,
} from '../src/lib/crewMood';
import { deriveSessionStatus } from '../src/lib/sessionStatus';
import { sessionKey, type BallMood, type BallState, type Session } from '../src/types';

const leader: Session = { id: 'leader', instanceId: 'host' };
const worker: Session = { id: 'worker', instanceId: 'host', kind: 'worker', lead: { instanceId: 'host', sessionId: 'leader' } };
const nested: Session = { id: 'nested', instanceId: 'host', kind: 'worker', lead: { instanceId: 'host', sessionId: 'worker' } };
const crews = crewByLeader([leader, worker, nested]);
const statesFor = (workerState: BallState, nestedState: BallState = 'idle') => Object.freeze({
  'host::leader': 'idle' as const,
  'host::worker': workerState,
  'host::nested': nestedState,
});

describe('crew appearance without changing turn state', () => {
  test('direct and nested active turns make resting leaders busy, including unread leaders', () => {
    for (const ownMood of ['idle', 'unread'] as const) {
      expect(crewAppearanceMood(leader, ownMood, crews, statesFor('active'))).toBe('busy');
      expect(crewAppearanceMood(leader, ownMood, crews, statesFor('idle', 'active'))).toBe('busy');
    }
    // A thinking descendant has the same operational active state as a tool-running one.
    expect(moodFrom('active', undefined, true)).toBe('thinking');
    expect(crewAppearanceMood(worker, 'idle', crews, statesFor('idle', 'active'))).toBe('busy');
  });

  test('settled, failed, unknown and blocked descendants do not invent active work', () => {
    for (const state of ['idle', 'error', 'unknown', 'needs-input'] as const) {
      expect(crewAppearanceMood(leader, 'idle', crews, statesFor(state, state))).toBe('idle');
      expect(crewAppearanceMood(leader, 'unread', crews, statesFor(state, state))).toBe('unread');
    }
    expect(crewAppearanceMood(leader, 'idle', crews, {})).toBe('idle');
    const blocked = crewByLeader([leader, { ...worker, needsInput: true }]);
    expect(crewAppearanceMood(leader, 'idle', blocked, statesFor('active'))).toBe('idle');
  });

  test('own thinking, needs-input precedence, errors and unknown status survive active descendants', () => {
    const active = statesFor('active', 'active');
    for (const mood of ['thinking', 'busy', 'question', 'input', 'error', 'unknown'] satisfies BallMood[]) {
      expect(crewAppearanceMood(leader, mood, crews, active)).toBe(mood);
    }
    expect(crewAppearanceMood(leader, moodFrom('needs-input', 'question', true), crews, active)).toBe('question');
    expect(crewAppearanceMood(leader, moodFrom('active', undefined, true), crews, active)).toBe('thinking');
  });

  test('peers and other hosts are not this leader’s active crew', () => {
    const unrelated = crewByLeader([leader, { ...worker, kind: 'peer' }, { ...nested, instanceId: 'other' }]);
    expect(crewAppearanceMood(leader, 'idle', unrelated, statesFor('active', 'active'))).toBe('idle');
  });

  test('cycles terminate and settled descendants restore the original appearance', () => {
    const cyclic = crewByLeader([{ ...leader, kind: 'worker', lead: nested.lead }, worker, nested]);
    expect(crewAppearanceMood(leader, 'idle', cyclic, statesFor('idle'))).toBe('idle');
    expect(crewAppearanceMood(leader, 'idle', crews, statesFor('active'))).toBe('busy');
    expect(crewAppearanceMood(leader, 'unread', crews, statesFor('idle'))).toBe('unread');
  });

  test('operational idle and the existing waiting status remain unchanged', () => {
    const states = statesFor('active');
    const input = { state: states['host::leader'], workers: [worker], workerStateFor: (w: Session) => states[sessionKey(w) as keyof typeof states] };
    const before = deriveSessionStatus(input);
    expect(crewAppearanceMood(leader, moodFrom(input.state, undefined, false), crews, states)).toBe('busy');
    expect(states['host::leader']).toBe('idle');
    expect(deriveSessionStatus(input)).toEqual(before);
    expect(before).toEqual({ kind: 'waiting-crew', text: 'Tackling 1 task.' });
  });
});

describe('crew cadence policy', () => {
  test('seeded independent moderate phases stay deterministic across reads', () => {
    const a = Array.from({ length: 60 }, (_, i) => crewActivityPhase('host::leader', i));
    expect(new Set(a)).toEqual(new Set(['busy', 'thinking']));
    expect(a).toEqual(Array.from({ length: 60 }, (_, i) => crewActivityPhase('host::leader', i)));
    expect(a).not.toEqual(Array.from({ length: 60 }, (_, i) => crewActivityPhase('other::leader', i)));
    const changes = a.flatMap((mood, i) => i && mood !== a[i - 1] ? [i] : []);
    for (let i = 1; i < changes.length; i++) {
      expect(changes[i] - changes[i - 1]).toBeGreaterThanOrEqual(6);
      expect(changes[i] - changes[i - 1]).toBeLessThanOrEqual(10);
    }
  });

  test('no cadence without active work, visibility, and normal motion', () => {
    for (const active of [true, false]) for (const visible of [true, false]) for (const reduced of [true, false]) {
      expect(shouldAlternateCrew(active, visible, reduced)).toBe(active && visible && !reduced);
    }
  });

  test('settled explicit assignments never animate from a stale active turn', () => {
    for (const status of ['waiting', 'blocked', 'incomplete', 'handoff-needed', 'done', 'stopped', 'failed'] as const) {
      const settled = crewByLeader([leader, { ...worker, task: { id: 'task:1', title: 'Task', status } }]);
      expect(crewAppearanceMood(leader, 'unread', settled, statesFor('active'))).toBe('unread');
    }
    const working = crewByLeader([leader, { ...worker, task: { id: 'task:1', title: 'Task', status: 'working' } }]);
    expect(crewAppearanceMood(leader, 'idle', working, statesFor('active'))).toBe('busy');
    expect(crewAppearanceMood(leader, 'idle', working, {})).toBe('idle');
  });

  test('nextCrewPhaseDelayMs finds exact earliest phase boundary across resting crew keys', () => {
    expect(nextCrewPhaseDelayMs(new Set(), 0)).toBeNull();
    const keys = new Set(['host::leader', 'other::leader']);
    let elapsedMs = 0;
    for (let step = 0; step < 8; step++) {
      const delayMs = nextCrewPhaseDelayMs(keys, elapsedMs);
      expect(delayMs).not.toBeNull();
      const boundary = elapsedMs + delayMs!;
      const before = [...keys].map((key) => crewActivityPhase(key, (boundary - 1) / 1000));
      const atStart = [...keys].map((key) => crewActivityPhase(key, elapsedMs / 1000));
      expect(before).toEqual(atStart);
      const after = [...keys].map((key) =>
        crewActivityPhase(key, (boundary + CREW_PHASE_BUFFER_MS) / 1000)
      );
      expect(after).not.toEqual(atStart);
      elapsedMs = boundary + CREW_PHASE_BUFFER_MS;
    }
  });

  test('resolveCrewMoods preserves reference equality across non-flipping timestamps', () => {
    const crewKeys = new Set(['host::leader']);
    const first = resolveCrewMoods(
      { 'host::leader': 'busy', 'host::peer': 'idle' },
      crewKeys,
      0,
      false
    );
    const delayMs = nextCrewPhaseDelayMs(crewKeys, 0)!;
    // Non-flipping timestamps and cloned poll inputs return the exact previous object reference.
    const mid = resolveCrewMoods(
      { 'host::leader': 'busy', 'host::peer': 'idle' },
      new Set(['host::leader']),
      Math.max(1, delayMs - 500),
      false,
      first
    );
    expect(mid).toBe(first);

    // Crossing the boundary flips the crew mood and returns a fresh object reference.
    const flipped = resolveCrewMoods(
      { 'host::leader': 'busy', 'host::peer': 'idle' },
      crewKeys,
      delayMs + CREW_PHASE_BUFFER_MS,
      false,
      mid
    );
    expect(flipped).not.toBe(mid);
    expect(flipped['host::leader']).not.toBe(first['host::leader']);
  });
});
