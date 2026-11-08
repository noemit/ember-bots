import { describe, expect, test } from 'bun:test';
import { moodFrom } from '../src/blob/mood';
import { crewByLeader } from '../src/lib/crew';
import { crewAppearanceMood } from '../src/lib/crewMood';
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
    expect(before).toEqual({ kind: 'waiting-crew', text: 'Waiting on 1 worker…' });
  });
});
