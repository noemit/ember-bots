import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashRemotePassword, MAX_REMOTE_PASSWORD_LENGTH, verifyRemotePassword } from '../electron/remoteAuth';
import { createRemoteServer, MAX_LOGIN_ATTEMPTS, MAX_LOGIN_VERIFY_IN_FLIGHT } from '../electron/remoteServer';

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

  test('accepts max-length passphrases and caps concurrent scrypt verifications on /remote/login bursts', async () => {
    const maxPass = 'p'.repeat(MAX_REMOTE_PASSWORD_LENGTH);
    const maxStored = await hashRemotePassword(maxPass);
    expect(await verifyRemotePassword(maxPass, maxStored)).toBe(true);
    expect(await verifyRemotePassword(maxPass + 'x', maxStored)).toBe(false);

    const directory = await mkdtemp(join(tmpdir(), 'ember-scrypt-burst-'));
    let activeVerifications = 0;
    let maxActiveVerifications = 0;
    let totalVerifications = 0;
    const server = createRemoteServer(directory, {
      modelStats: { list: async () => [], observe: async () => [], clear: async () => {} },
      listInstances: async () => [],
      getSettings: () => ({}),
      setSettings: async (patch) => patch,
      request: async () => ({ ok: true, status: 200, data: {} }),
      verifyPassword: async (candidate) => {
        totalVerifications += 1;
        activeVerifications += 1;
        maxActiveVerifications = Math.max(maxActiveVerifications, activeVerifications);
        try {
          return await verifyRemotePassword(candidate, maxStored);
        } finally {
          activeVerifications -= 1;
        }
      },
      subscribeEvents: () => () => {},
      eventStatus: () => ({}),
    }, { failedLoginDelayMs: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          fetch(`${url}/remote/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: `wrong-attempt-${index}` }),
          })
        )
      );
      expect(maxActiveVerifications).toBeLessThanOrEqual(MAX_LOGIN_VERIFY_IN_FLIGHT);
      expect(totalVerifications).toBeLessThanOrEqual(MAX_LOGIN_ATTEMPTS);
      expect(responses.filter((res) => res.status === 429).length).toBeGreaterThanOrEqual(20 - MAX_LOGIN_ATTEMPTS);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true });
    }
  });
});
