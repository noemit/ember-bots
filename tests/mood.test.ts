import { describe, expect, test } from 'bun:test';
import { moodFrom, stateFromMood } from '../src/blob/mood';

describe('moodFrom', () => {
  test('maps state, prompt kind and thinking to a mood', () => {
    expect(moodFrom('idle', undefined, false)).toBe('idle');
    expect(moodFrom('active', undefined, true)).toBe('thinking');
    expect(moodFrom('active', undefined, false)).toBe('busy');
    expect(moodFrom('needs-input', 'question', false)).toBe('question');
    expect(moodFrom('needs-input', 'input', false)).toBe('input');
    expect(moodFrom('error', undefined, false)).toBe('error');
  });

  test('an idle session with an unread response is unread, but prompts and errors win', () => {
    expect(moodFrom('idle', undefined, false, true)).toBe('unread');
    expect(moodFrom('idle', undefined, false, false)).toBe('idle');
    expect(moodFrom('active', undefined, false, true)).toBe('busy');
    expect(moodFrom('needs-input', 'input', false, true)).toBe('input');
    expect(moodFrom('error', undefined, false, true)).toBe('error');
  });

  test('unread collapses back to the coarse idle state', () => {
    expect(stateFromMood('unread')).toBe('idle');
  });

  test('an unknown status is its own mood, in both directions', () => {
    // Not idle: that is the whole point of the state existing.
    expect(moodFrom('unknown', undefined, false)).toBe('unknown');
    expect(moodFrom('unknown', 'question', false, true)).toBe('unknown');
    expect(stateFromMood('unknown')).toBe('unknown');
    // And it does not disturb the known states around it.
    expect(moodFrom('idle', undefined, false)).toBe('idle');
    expect(stateFromMood('busy')).toBe('active');
  });
});
