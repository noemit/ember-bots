import { describe, expect, test } from 'bun:test';
import { hashRemotePassword, MAX_REMOTE_PASSWORD_LENGTH, verifyRemotePassword } from '../electron/remoteAuth';

describe('remote access authentication', () => {
  test('hashes passwords without storing the plaintext and verifies them', async () => {
    const stored = await hashRemotePassword('correct horse battery staple');
    expect(stored).not.toContain('correct horse battery staple');
    expect(await verifyRemotePassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyRemotePassword('wrong password', stored)).toBe(false);
  });

  test('rejects malformed password hashes', async () => {
    expect(await verifyRemotePassword('password', undefined)).toBe(false);
    expect(await verifyRemotePassword('password', 'scrypt$bad$hash')).toBe(false);
    expect(await verifyRemotePassword('password', 'bcrypt$salt$' + 'a'.repeat(64))).toBe(false);
  });

  test('never hashes an over-long password: the cap is what keeps the cost bounded', async () => {
    const stored = await hashRemotePassword('the-right-password');
    expect(await verifyRemotePassword('a'.repeat(MAX_REMOTE_PASSWORD_LENGTH), stored)).toBe(false);
    expect(await verifyRemotePassword('a'.repeat(MAX_REMOTE_PASSWORD_LENGTH + 1), stored)).toBe(false);
    // A megabyte of input is refused before scrypt runs, not after.
    const startedAt = performance.now();
    expect(await verifyRemotePassword('a'.repeat(1024 * 1024), stored)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(50);
  });

  test('a check does not block the caller: hashing is asynchronous', async () => {
    const stored = await hashRemotePassword('the-right-password');
    // Two checks in flight at once both complete — the sync version serialised them on one thread.
    const results = await Promise.all([
      verifyRemotePassword('the-right-password', stored),
      verifyRemotePassword('the-right-password', stored),
      verifyRemotePassword('wrong', stored),
    ]);
    expect(results).toEqual([true, true, false]);
  });
});
