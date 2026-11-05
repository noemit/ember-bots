import { describe, expect, test } from 'bun:test';
import {
  classifyFullReadFailure,
  FULL_REPAIR_MAX_FAILURES,
  RepairBudget,
} from './src/lib/repairBudget';

/**
 * A full read can never succeed for a session larger than the response cap, and nothing used to stop
 * Ember asking: every trigger — opening the column, a reconnect, the poll, a turn ending — asked
 * again, for as long as the session was open. This is the breaker that stops it, and it has to stop
 * exactly the automatic requests while still letting the reader ask.
 */

const ref = { instanceId: 'pi:hearth', sessionId: 'conv-1' };
const other = { instanceId: 'pi:hearth', sessionId: 'conv-2' };

describe('the full-read breaker', () => {
  test('it allows repairs until the failure count reaches the limit', () => {
    const budget = new RepairBudget();
    expect(budget.allows(ref)).toBe(true);
    for (let attempt = 1; attempt < FULL_REPAIR_MAX_FAILURES; attempt += 1) {
      budget.failed(ref, 'too-large');
      expect(budget.allows(ref)).toBe(true);
      expect(budget.halt(ref)).toBeNull();
    }
    budget.failed(ref, 'too-large');
    expect(budget.allows(ref)).toBe(false);
  });

  test('the halt says why, because only one of the reasons will not fix itself', () => {
    const budget = new RepairBudget();
    for (let attempt = 0; attempt < FULL_REPAIR_MAX_FAILURES; attempt += 1) budget.failed(ref, 'too-large');
    expect(budget.halt(ref)).toEqual({ failures: FULL_REPAIR_MAX_FAILURES, reason: 'too-large' });

    const timing = new RepairBudget();
    for (let attempt = 0; attempt < FULL_REPAIR_MAX_FAILURES; attempt += 1) timing.failed(other, 'error');
    expect(timing.halt(other)?.reason).toBe('error');
  });

  test('one success clears the count, so a bad minute is not a broken session', () => {
    const budget = new RepairBudget();
    for (let attempt = 0; attempt < FULL_REPAIR_MAX_FAILURES; attempt += 1) budget.failed(ref, 'error');
    expect(budget.allows(ref)).toBe(false);
    budget.succeeded(ref);
    expect(budget.allows(ref)).toBe(true);
    expect(budget.halt(ref)).toBeNull();
  });

  test('sessions do not share a count', () => {
    const budget = new RepairBudget();
    for (let attempt = 0; attempt < FULL_REPAIR_MAX_FAILURES; attempt += 1) budget.failed(ref, 'too-large');
    expect(budget.allows(other)).toBe(true);
    expect(budget.failed(other, 'error')).toBe(1);
  });

  test('it forgets sessions that are no longer being read', () => {
    const budget = new RepairBudget();
    budget.failed(ref, 'too-large');
    budget.failed(other, 'too-large');
    budget.retain([other]);
    // `ref` starts fresh — not because it recovered, but because Ember is no longer reading it.
    expect(budget.failed(ref, 'error')).toBe(1);
    expect(budget.failed(other, 'error')).toBe(2);
  });
});

describe('classifying a failed full read', () => {
  test("the transport's refusal is the one that cannot fix itself", () => {
    expect(classifyFullReadFailure(new Error('Response body is too large'))).toBe('too-large');
    // The same sentence is thrown from both the header check and the streaming check, so both paths
    // land here; anything else is an ordinary failure the poller retries.
    expect(classifyFullReadFailure(new Error('Failed to load conversation c1 history (502).'))).toBe('error');
    expect(classifyFullReadFailure(new Error('fetch failed'))).toBe('error');
    expect(classifyFullReadFailure('a bare string')).toBe('error');
    expect(classifyFullReadFailure(undefined)).toBe('error');
  });
});
