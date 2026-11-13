import { describe, expect, test } from 'bun:test';
import { judgeLoginAnswer, signInAddressLabel } from '../src/lib/loginAnswer';

/**
 * A browser sign-in finishes by parking the flow on a question: the person pastes the redirect URL
 * their browser landed on, which failed to load because that address is on the machine running
 * Kiln, not on theirs. The helper below is the only thing standing between a paste and a slow,
 * confusing failure from Google, so it has to accept the shapes people actually paste and refuse
 * the ones that cannot be an answer — without pretending to verify what only the host can.
 */

const REDIRECT = 'http://localhost:51121/oauth-callback';

describe('judging a pasted sign-in answer', () => {
  test('the full redirect URL from the address bar is an answer', () => {
    const verdict = judgeLoginAnswer(`${REDIRECT}?state=abc&code=4/0AX4Xf&scope=x`, REDIRECT);
    expect(verdict.ok).toBe(true);
    // Passed through untouched: the host parses it, and a mangled value wastes a single-use code.
    expect(verdict.ok ? verdict.value : '').toBe(`${REDIRECT}?state=abc&code=4/0AX4Xf&scope=x`);
  });

  test('localhost and 127.0.0.1 are the same listener', () => {
    // Hosts differ on which they tell the browser, and a person who trimmed nothing must not be
    // corrected for a difference they cannot see.
    expect(judgeLoginAnswer('http://127.0.0.1:51121/oauth-callback?code=abc12345', REDIRECT).ok).toBe(true);
  });

  test('the shortened tail is still an answer', () => {
    const verdict = judgeLoginAnswer('code=4/0AX4Xf&state=abc', REDIRECT);
    expect(verdict.ok).toBe(true);
    // Marked as a query string so the host reads it as one rather than as a bare (wrong) code.
    expect(verdict.ok ? verdict.value : '').toBe('?code=4/0AX4Xf&state=abc');
  });

  test('a bare code is an answer', () => {
    expect(judgeLoginAnswer('4/0AX4XfGh_9-abc', REDIRECT).ok).toBe(true);
  });

  test('whitespace around the paste is not part of the answer', () => {
    expect(judgeLoginAnswer(`  ${REDIRECT}?code=abc12345  \n`, REDIRECT).ok).toBe(true);
  });

  test('silence is not an error: the Send button simply waits', () => {
    const verdict = judgeLoginAnswer('   ', REDIRECT);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? null : verdict.reason).toBeNull();
  });

  test('a different page is refused with the recovery that is on screen', () => {
    const verdict = judgeLoginAnswer('https://accounts.google.com/signin/oauth/consent?x=1', REDIRECT);
    expect(verdict.ok).toBe(false);
    const reason = verdict.ok ? '' : verdict.reason ?? '';
    expect(reason).toContain('redirect');
    // Points at the address shown beside the field rather than saying "invalid".
    expect(reason).toContain('address bar');
  });

  test('without a redirect template, a URL still has to carry a code', () => {
    expect(judgeLoginAnswer('http://localhost:51121/oauth-callback?code=abc12345').ok).toBe(true);
    expect(judgeLoginAnswer('https://example.test/landing').ok).toBe(false);
  });

  test('a sentence is refused, not sent to fail slowly on the host', () => {
    const verdict = judgeLoginAnswer('I signed in but it said it could not connect', REDIRECT);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason ?? '').toContain('address bar');
  });

  test('a javascript: URL is never treated as the redirect', () => {
    // The URL only ever travels to the host, but a helper that calls something a redirect because it
    // parses is a helper someone will later trust for more than this.
    const verdict = judgeLoginAnswer('javascript:alert(1)//?code=abc', REDIRECT);
    expect(verdict.ok).toBe(false);
  });

  test('the address label is what a person can recognise, and never throws', () => {
    expect(signInAddressLabel(`${REDIRECT}?state=…`)).toBe('localhost:51121/oauth-callback');
    expect(signInAddressLabel(undefined)).toContain('redirect');
    // A host that sends something unparseable must not take the dialog down during render.
    expect(signInAddressLabel('not a url')).toBe('not a url');
  });
});
