import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { defaultProbe, startLocalHarness } from '../electron/localHarness';
import { resolveVerifiedTailscaleAddress } from '../electron/remoteServer';
import { redactRemoteSettings, withoutDesktopOnlySettings } from '../electron/transport';
import { FileCredentialStore } from '../packages/kiln/src/credentials';

const require = createRequire(import.meta.url);
const notarize = require('../build/notarize.js') as {
  buildNotaryArgs: (zipPath: string, env?: Record<string, string | undefined>) => {
    mode: string;
    args: string[];
    secrets: string[];
  } | null;
  run: (command: string, args: string[], options?: Record<string, unknown>, secrets?: string[]) => string;
  sanitizeNotarizeText: (text: string, secrets?: string[]) => string;
};

describe('Phase 3 security boundaries (S1, S2, S3, S5, S7)', () => {
  test('S1: remote settings exclude composerDrafts and composerDraftChanges in both directions', () => {
    const desktopSettings = {
      theme: 'ember',
      composerDrafts: { 'pi:local::1': { text: 'unsent desktop secret', updatedAt: 1 } },
      composerDraftChanges: { 'pi:local::1': { text: 'unsent change', updatedAt: 2 } },
      piEndpoints: [{ id: 'pi:local', label: 'Local', url: 'http://127.0.0.1:3002', token: 'secret-tok' }],
    };
    const readResponse = redactRemoteSettings(desktopSettings);
    expect(readResponse.composerDrafts).toEqual({});
    expect('composerDraftChanges' in readResponse).toBe(false);
    expect(JSON.stringify(readResponse)).not.toContain('unsent desktop secret');
    expect(readResponse.piEndpoints[0]!.token).toBe('');

    const remotePatch = withoutDesktopOnlySettings({
      theme: 'stone',
      composerDrafts: { 'pi:local::1': { text: 'remote overwrite', updatedAt: 3 } },
      composerDraftChanges: { 'pi:local::1': null },
      piEndpoints: [],
    }) as Record<string, unknown>;
    expect(remotePatch).toEqual({ theme: 'stone' });
    expect('composerDrafts' in remotePatch).toBe(false);
    expect('composerDraftChanges' in remotePatch).toBe(false);
  });

  test('S2: Tailscale bind requires daemon-confirmed IP present on an active local interface', () => {
    const fakeIfaces = {
      en0: [{ address: '100.64.12.34', netmask: '255.192.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '100.64.12.34/10' }],
      utun4: [{ address: '100.99.1.5', netmask: '255.255.255.255', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '100.99.1.5/32' }],
    };

    // Ambiguous CGNAT interface with no daemon confirmation must fail closed (null).
    expect(resolveVerifiedTailscaleAddress({ interfaces: fakeIfaces, readDaemonIp: () => null })).toBeNull();
    // Daemon IP not matching any active local interface must fail closed.
    expect(resolveVerifiedTailscaleAddress({ interfaces: fakeIfaces, readDaemonIp: () => '100.88.7.7' })).toBeNull();
    // Verified daemon IP matching an active local interface succeeds (even on macOS utunN).
    expect(resolveVerifiedTailscaleAddress({ interfaces: fakeIfaces, readDaemonIp: () => '100.99.1.5' })).toBe('100.99.1.5');
  });

  test('S3: local harness respects disabled before probing and never sends bearer token before challenge proof', async () => {
    let probeCalls = 0;
    const disabled = await startLocalHarness({
      resourcesDir: '/nonexistent',
      home: '/nonexistent',
      disabled: true,
      probe: async () => {
        probeCalls += 1;
        return { ok: true };
      },
    });
    expect(disabled.state.kind).toBe('disabled');
    expect(probeCalls).toBe(0);

    // Rogue local listener returning invalid proof must never receive Authorization header.
    const rogueHeaders: Array<Record<string, string>> = [];
    const rogueResult = await defaultProbe('http://127.0.0.1:39999', 'super-secret-token', {
      fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        rogueHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return Response.json({ service: 'hearth', proof: '0'.repeat(64) });
      }) as typeof fetch,
    });
    expect(rogueResult).toEqual({ ok: false, occupied: true });
    expect(rogueHeaders).toHaveLength(1);
    expect(rogueHeaders[0]!.authorization).toBeUndefined();

    // Legitimate Kiln answering valid HMAC challenge receives /health probe and succeeds.
    const validCalls: string[] = [];
    const validResult = await defaultProbe('http://127.0.0.1:39999', 'real-token-xyz', {
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = new URL(String(input));
        validCalls.push(u.pathname);
        if (u.pathname === '/health/challenge') {
          expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
          const nonce = u.searchParams.get('nonce')!;
          const proof = createHmac('sha256', 'real-token-xyz').update(`kiln-health:${nonce}`).digest('hex');
          return Response.json({ service: 'hearth', proof });
        }
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer real-token-xyz');
        return Response.json({ service: 'hearth', version: '1.14.0' });
      }) as typeof fetch,
    });
    expect(validResult).toEqual({ ok: true, version: '1.14.0' });
    expect(validCalls).toEqual(['/health/challenge', '/health']);
  });

  test('S5: notarize prefers Keychain profile and redacts password from thrown child errors', () => {
    const keychain = notarize.buildNotaryArgs('/tmp/app.zip', {
      APPLE_KEYCHAIN_PROFILE: 'ember-notary',
      APPLE_PASSWORD: 'aaaa-bbbb-cccc-dddd',
    });
    expect(keychain?.mode).toBe('keychain');
    expect(keychain?.args).toContain('--keychain-profile');
    expect(keychain?.args).not.toContain('--password');

    const dummySecret = 'xxxx-yyyy-zzzz-wwww';
    let caught: Error | undefined;
    try {
      notarize.run(
        process.execPath,
        ['-e', `console.error("bad creds --password ${dummySecret}"); process.exit(2);`, '--password', dummySecret],
        {},
        [dummySecret]
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain(dummySecret);
    expect(caught!.stack ?? '').not.toContain(dummySecret);
    expect((caught as Error & { status?: number }).status).toBe(2);
  });

  test('S7: FileCredentialStore keeps in-memory state unchanged when delete persistence fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ember-cred-s7-'));
    const file = join(dir, 'auth.json');
    try {
      writeFileSync(file, JSON.stringify({ openai: { type: 'api_key', key: 'sk-test-123' } }), { mode: 0o600 });
      const store = new FileCredentialStore(file);
      expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'sk-test-123' });

      if (process.platform !== 'win32') {
        // Replace the target file path with a directory after load() so atomic renameSync fails with EISDIR.
        rmSync(file);
        const { mkdirSync } = require('node:fs') as typeof import('node:fs');
        mkdirSync(file);
        try {
          await expect(store.delete('openai')).rejects.toThrow();
          // Live memory must still retain the credential because disk was not updated!
          expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'sk-test-123' });
          // Retrying while still failing must still throw rather than silently succeeding.
          await expect(store.delete('openai')).rejects.toThrow();
        } finally {
          rmSync(file, { recursive: true, force: true });
          writeFileSync(file, JSON.stringify({ openai: { type: 'api_key', key: 'sk-test-123' } }), { mode: 0o600 });
        }
        // Once writable again, retry succeeds and persists cleanly.
        await store.delete('openai');
        expect(await store.read('openai')).toBeUndefined();
        const reopened = new FileCredentialStore(file);
        expect(await reopened.read('openai')).toBeUndefined();
      }
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
