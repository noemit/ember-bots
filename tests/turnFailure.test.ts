import { describe, expect, test } from 'bun:test';
import { describeTurnFailure, failureLabel, readTurnFailure, redact } from '../src/lib/turnFailure';

/**
 * These fixtures are real: they were read out of a live conversation's `pi.assistant` entries
 * (Moonshot, `kimi-k3.1-pro`). Three different 429s that need three different responses is exactly
 * why the old single-line banner was not good enough.
 */
const OVERLOADED =
  '429: {"message":"The engine is currently overloaded, please try again later","type":"engine_overloaded_error"}';

const TPM_LIMIT =
  '429: {"message":"Your account org-0fc75c915eb946f48b877ea3f062e3e9 / proj-2beab80c8b6f4b65852ad2181b584007 <ak-fdfwhy4b5bd111gnmj9i> request reached organization TPM rate limit, current: 2066691, limit: 2000000","type":"rate_limit_reached_error"}';

const NO_CREDIT =
  '429: {"message":"Your credit balance is running low for account <org-0fc75c915eb946f48b877ea3f062e3e9>, please recharge immediately to avoid service disruption","type":"exceeded_current_quota_error"}';

describe('a failed turn names the actual error', () => {
  test('an overloaded engine reads as overloaded, with its status', () => {
    const failure = readTurnFailure(OVERLOADED);
    expect(failure.kind).toBe('overloaded');
    expect(failure.status).toBe(429);
    expect(failure.code).toBe('engine_overloaded_error');
    expect(failure.retryable).toBe(true);
    expect(failureLabel(failure)).toBe('Provider overloaded (429)');
  });

  test('a TPM rate limit reads as rate limited, not as overload', () => {
    const failure = readTurnFailure(TPM_LIMIT);
    expect(failure.kind).toBe('rate-limit');
    expect(failure.status).toBe(429);
    expect(failure.retryable).toBe(true);
    expect(failureLabel(failure)).toBe('Rate limited (429)');
  });

  test('a drained balance is not "retryable" — retrying is the wrong advice', () => {
    const failure = readTurnFailure(NO_CREDIT);
    expect(failure.kind).toBe('quota');
    expect(failure.status).toBe(429);
    expect(failure.retryable).toBe(false);
    expect(describeTurnFailure(failure)).toContain('Add credit');
  });

  test('a 401 reads as an auth problem', () => {
    const failure = readTurnFailure('401: {"message":"Invalid API key","type":"authentication_error"}');
    expect(failure.kind).toBe('auth');
    expect(failure.retryable).toBe(false);
    expect(describeTurnFailure(failure)).toContain('Check the API key');
  });

  test('a 5xx is retryable', () => {
    const failure = readTurnFailure('503: {"message":"Service unavailable"}');
    expect(failure.kind).toBe('server');
    expect(failure.retryable).toBe(true);
  });

  test('a bare message with no status still classifies', () => {
    const failure = readTurnFailure('fetch failed');
    expect(failure.kind).toBe('network');
    expect(failure.status).toBeUndefined();
    expect(failure.retryable).toBe(true);
  });

  test('no message at all degrades honestly instead of inventing one', () => {
    const failure = readTurnFailure(undefined, 'error');
    expect(failure.kind).toBe('unknown');
    expect(failure.detail).toContain('without reporting a reason');
    expect(failureLabel(failure)).toBe('Failed');
  });
});

describe('provider identifiers are redacted', () => {
  test('org, project and key ids never reach the banner', () => {
    const failure = readTurnFailure(TPM_LIMIT);
    expect(failure.detail).not.toContain('0fc75c915eb946f48b877ea3f062e3e9');
    expect(failure.detail).not.toContain('2beab80c8b6f4b65852ad2181b584007');
    expect(failure.detail).not.toContain('fdfwhy4b5bd111gnmj9i');
    expect(failure.detail).toContain('org-…');
  });

  test('a key-shaped string is masked wherever it appears', () => {
    expect(redact('using sk-6LF37lcrAncbUxvvmgk7UZlrHsgK5MpamirTkLOBZ80KbC2H now')).toBe('using sk-… now');
  });

  test('the useful part of a long rate-limit paragraph survives', () => {
    const failure = readTurnFailure(TPM_LIMIT);
    expect(failure.detail).toContain('TPM rate limit');
    expect(failure.detail.length).toBeLessThanOrEqual(221);
  });
});

describe('the banner text', () => {
  test('names the failure and what to do', () => {
    const text = describeTurnFailure(readTurnFailure(OVERLOADED));
    expect(text).toContain('Provider overloaded (429)');
    expect(text).toContain('engine is currently overloaded');
    expect(text).toContain('Try again in a moment');
  });

  test('never says "The model turn failed (error)"', () => {
    for (const raw of [OVERLOADED, TPM_LIMIT, NO_CREDIT]) {
      expect(describeTurnFailure(readTurnFailure(raw))).not.toContain('The model turn failed');
    }
  });
});
