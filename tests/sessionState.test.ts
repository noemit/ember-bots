import { describe, expect, test } from 'bun:test';
import {
  STATE_STALE_AFTER_MS,
  instancesWithFreshStates,
  sessionStates,
} from '../src/lib/sessionState';
import type { Instance, Session } from '../src/types';

const instance = (id: string, attachable = true): Instance => ({
  id,
  label: id,
  kind: 'pi',
  status: attachable ? 'ready' : 'unreachable',
  attachable,
});

const session = (id: string, instanceId = 'a'): Session => ({ id, instanceId, updated: 1 });

const NOW = 1_800_000_000_000;

describe('instancesWithFreshStates', () => {
  const instances = [instance('a'), instance('b'), instance('c', false)];

  test('an instance with no answer yet is not fresh', () => {
    expect(instancesWithFreshStates(instances, {}, NOW)).toEqual(new Set());
    // Answers for one instance do not vouch for another.
    expect(instancesWithFreshStates(instances, { a: NOW }, NOW)).toEqual(new Set(['a']));
  });

  test('an unreachable instance is not fresh however recently it answered', () => {
    expect(instancesWithFreshStates(instances, { a: NOW, b: NOW, c: NOW }, NOW)).toEqual(new Set(['a', 'b']));
  });

  test('an answer ages out, so a poll that stopped answering stops counting as knowledge', () => {
    expect(instancesWithFreshStates([instance('a')], { a: NOW - STATE_STALE_AFTER_MS }, NOW)).toEqual(
      new Set(['a'])
    );
    expect(
      instancesWithFreshStates([instance('a')], { a: NOW - STATE_STALE_AFTER_MS - 1 }, NOW)
    ).toEqual(new Set());
  });
});

describe('sessionStates', () => {
  const sessions = { a: [session('1'), session('2')] };

  test('a session on an instance with no answer is unknown, never idle', () => {
    expect(sessionStates(sessions, {}, new Set())).toEqual({ 'a::1': 'unknown', 'a::2': 'unknown' });
  });

  test('a session on an answered instance is idle when the host listed nothing for it', () => {
    // The status endpoint omits idle sessions, so a missing entry *after an answer* is a real idle.
    expect(sessionStates(sessions, { a: {} }, new Set(['a']))).toEqual({ 'a::1': 'idle', 'a::2': 'idle' });
  });

  test('a reported state is carried through', () => {
    expect(sessionStates(sessions, { a: { 'a::2': 'active' } }, new Set(['a']))).toEqual({
      'a::1': 'idle',
      'a::2': 'active',
    });
  });

  test('a failed poll turns a known state into unknown, not into idle', () => {
    const reported = { a: { 'a::2': 'active' } };
    // Same map, but the answer has aged past the trust window: 'active' must not survive as a claim,
    // and must not collapse to 'idle' either — both would be guesses.
    const aged = instancesWithFreshStates(
      [instance('a'), instance('b', false)],
      { a: NOW - STATE_STALE_AFTER_MS - 1, b: NOW - STATE_STALE_AFTER_MS - 1 },
      NOW
    );
    expect(sessionStates(sessions, reported, aged)).toEqual({ 'a::1': 'unknown', 'a::2': 'unknown' });
  });
});
