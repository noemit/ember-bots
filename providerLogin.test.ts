import { describe, expect, test } from 'bun:test';
import { loginPollOutcome, verificationHostLabel } from './src/lib/providerLogin';

/**
 * A sign-in poll must not turn "Hearth did not answer" into "signed in". The host stores the
 * credential itself, but forgets successful and failed flows alike. Missing state is not proof.
 */
describe('what a sign-in poll means', () => {
  test('a pending flow is pending', () => {
    expect(loginPollOutcome({ ok: true, status: 200, state: { status: 'pending' } })).toEqual({ kind: 'pending' });
  });

  test('a complete flow is complete', () => {
    expect(loginPollOutcome({ ok: true, status: 200, state: { status: 'complete' } })).toEqual({ kind: 'complete' });
  });

  test('a failed flow carries the host’s reason', () => {
    const outcome = loginPollOutcome({ ok: true, status: 200, state: { status: 'failed', error: 'expired' } });
    expect(outcome).toEqual({ kind: 'failed', error: 'expired' });
  });

  test('a missing flow never claims success and offers a new attempt', () => {
    const outcome = loginPollOutcome({ ok: false, status: 404 });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toMatch(/Kiln/);
      expect(outcome.error).toMatch(/try again/i);
      expect(outcome.error).not.toMatch(/404|undefined|null/);
    }
  });

  test('a 500 is not success', () => {
    const outcome = loginPollOutcome({ ok: false, status: 500, error: 'Hearth failed' });
    expect(outcome.kind).toBe('unreachable');
  });

  test('no answer at all is not success, and says what to do', () => {
    const outcome = loginPollOutcome({ ok: false, status: 0 });
    expect(outcome.kind).toBe('unreachable');
    if (outcome.kind === 'unreachable') {
      expect(outcome.error).toMatch(/host|ember-harness/i);
      expect(outcome.error.length).toBeGreaterThan(20);
    }
  });

  test('a 401 is not success either', () => {
    expect(loginPollOutcome({ ok: false, status: 401 }).kind).toBe('unreachable');
  });
});

/**
 * S4-8: a host-supplied `verificationUri` is not guaranteed to parse, and `new URL(...)` throws a
 * `TypeError` on anything that isn't an absolute URL — during render, which takes the whole dialog
 * (and the tree around it) down. The label is a nicety, so it degrades instead of throwing.
 */
describe('the sign-in link label', () => {
  test('a normal URI is labelled with its host', () => {
    expect(verificationHostLabel('https://accounts.x.ai/device')).toBe('accounts.x.ai');
    expect(verificationHostLabel('http://127.0.0.1:1456/activate?code=AB-12')).toBe('127.0.0.1:1456');
  });

  test('a URI that cannot be parsed is shown raw rather than throwing', () => {
    for (const bad of ['accounts.x.ai/device', 'http://', 'not a url', '   ', '']) {
      expect(() => verificationHostLabel(bad)).not.toThrow();
    }
    // Still says something the reader can act on.
    expect(verificationHostLabel('accounts.x.ai/device')).toBe('accounts.x.ai/device');
    expect(verificationHostLabel('  spaced.example/device  ')).toBe('spaced.example/device');
  });

  test('nothing at all still reads as a sentence', () => {
    expect(verificationHostLabel(undefined)).toBe('the sign-in page');
    expect(verificationHostLabel(null)).toBe('the sign-in page');
    expect(verificationHostLabel('   ')).toBe('the sign-in page');
  });
});
