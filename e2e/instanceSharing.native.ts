import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createRemoteServer } from '../electron/remoteServer';
import { redactRemoteSettings, withoutDesktopOnlySettings } from '../electron/transport';
import type {} from '../src/types';

const load = createRequire(resolve('package.json'));
const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind loopback');
  return `http://127.0.0.1:${address.port}`;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
};

// No bundled harness, real Tailscale executable, Tailnet request, or exposure is used here.
// The fake executable reports Tailscale stopped so enable must fail before creating a forward.
test('isolated native instance IPC verifies Kiln, masks Access, and keeps sharing desktop-only', async ({ browser }) => {
  test.skip(process.platform === 'win32', 'The fixture executable uses a POSIX shell; Windows is covered by packaged tests separately.');
  const home = await mkdtemp(join(tmpdir(), 'ember-sharing-native-'));
  const data = join(home, 'data');
  const bin = join(home, 'bin');
  const profile = join(home, 'profile');
  const calls = join(home, 'tailscale-calls.jsonl');
  const token = 'native-fixture-bearer';
  const accessSecret = 'native-fixture-access-secret';
  const requests: { path: string; authorized: boolean }[] = [];
  const upstream = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const authorized = request.headers.authorization === `Bearer ${token}`;
    requests.push({ path, authorized });
    response.setHeader('Content-Type', 'application/json');
    if (!authorized) { response.writeHead(401); response.end(JSON.stringify({ error: 'denied' })); return; }
    if (path === '/health') response.end(JSON.stringify({ ok: true, service: 'hearth', version: '1.2.3' }));
    else if (path === '/conversations') response.end(JSON.stringify({ conversations: [] }));
    else { response.writeHead(404); response.end(JSON.stringify({ error: 'fixture route unavailable' })); }
  });
  const wrongService = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, service: 'unrelated-site' }));
  });
  let app: ElectronApplication | undefined;
  let remote: Server | undefined;
  const context = await browser.newContext();
  try {
    const url = await listen(upstream);
    const wrongUrl = await listen(wrongService);
    await Promise.all([mkdir(data, { recursive: true }), mkdir(bin, { recursive: true }), mkdir(profile, { recursive: true }), mkdir(join(home, 'openchamber'), { recursive: true })]);
    await writeFile(calls, '');
    const fakeTailscale = join(bin, 'tailscale');
    await writeFile(fakeTailscale, `#!/bin/sh
printf '%s\\n' "$*" >> "$EMBER_TEST_TAILSCALE_CALLS"
case "$*" in
  'status --json') printf '%s\\n' '{"BackendState":"Stopped","Self":{"Online":false,"TailscaleIPs":[]}}' ;;
  'serve status --json') printf '%s\\n' '{}' ;;
  *) printf '%s\\n' 'Native fixture refuses every mutation' >&2; exit 97 ;;
esac
`, { mode: 0o700 });
    await writeFile(join(data, 'settings.json'), JSON.stringify({
      localHarnessEnabled: false, remoteAccessEnabled: false, onboardedAt: Date.now(),
      piEndpoints: [{ id: 'pi:fixture', label: 'Native fixture', url, token }],
    }));
    const bootstrap = join(home, 'bootstrap.cjs');
    // Fixture-only crypto adapter: validates the real main/preload persistence and masking path
    // without reading/writing the person's OS keyring. The random AES key lives only in this child.
    await writeFile(bootstrap, `const { app, safeStorage } = require('electron');
const crypto = require('node:crypto');
const key = crypto.randomBytes(32);
Object.defineProperties(safeStorage, {
  isEncryptionAvailable: {value: () => true},
  getSelectedStorageBackend: {value: () => 'native-test-only'},
  encryptString: {value: value => {const iv=crypto.randomBytes(12);const c=crypto.createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]);}},
  decryptString: {value: value => {const d=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));d.setAuthTag(value.subarray(12,28));return Buffer.concat([d.update(value.subarray(28)),d.final()]).toString('utf8');}}
});
if (require('node:os').homedir() !== process.env.EMBER_TEST_HOME) throw new Error('Native test HOME is not isolated');
app.setPath('userData', process.env.EMBER_TEST_PROFILE);
app.setPath('sessionData', process.env.EMBER_TEST_PROFILE);
app.on('browser-window-created', (_event, win) => win.setFocusable(false));
require(process.env.EMBER_TEST_ENTRY);
`);
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      HOME: home, EMBER_DATA_DIR: data, EMBER_TEST_HOME: home, EMBER_TEST_PROFILE: profile,
      EMBER_TEST_ENTRY: resolve('dist-electron/main.js'), OPENCHAMBER_DATA_DIR: join(home, 'openchamber'),
      PATH: `${bin}:/usr/bin:/bin`, EMBER_TEST_TAILSCALE_CALLS: calls,
      EMBER_BUNDLED_HARNESS: join(home, 'deliberately-missing-kiln'),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: load('electron') as string, args: [bootstrap], env });
    const window = await app.firstWindow();
    await window.waitForFunction(() => Boolean(window.ember?.testPiEndpoint && window.ember?.kilnSharing));

    await test.step('trusted preload IPC proves service identity and authenticated route readiness', async () => {
      const ready = await window.evaluate((draft) => window.ember.testPiEndpoint!(draft), { label: 'Native fixture', url, token });
      expect(ready.outcome).toBe('ready');
      expect(ready.host).toBe('Native fixture');
      const rejected = await window.evaluate((draft) => window.ember.testPiEndpoint!(draft), { label: 'Native fixture', url, token: 'incorrect-fixture-bearer' });
      expect(rejected.outcome).toBe('auth-rejected');
      const wrong = await window.evaluate((draft) => window.ember.testPiEndpoint!(draft), { label: 'Wrong fixture', url: wrongUrl, token });
      expect(wrong.outcome).toBe('wrong-service');
      expect(requests.some((item) => item.path === '/health' && item.authorized)).toBe(true);
      expect(requests.some((item) => item.path === '/conversations' && item.authorized)).toBe(true);
      expect(JSON.stringify([ready, rejected, wrong])).not.toContain(token);
    });

    await test.step('Access secrets are encrypted on disk and masked in every desktop settings preview', async () => {
      const result = await window.evaluate(async ({ token, accessSecret }) => {
        const settings = await window.ember.getSettings();
        const endpoint = settings.piEndpoints.find((item) => item.id === 'pi:fixture')!;
        return window.ember.setSettings({ piEndpoints: [{ ...endpoint, url: endpoint.url.replace('http:', 'https:'), token,
          access: { clientId: 'native-fixture-client', clientSecret: accessSecret } }] });
      }, { token, accessSecret });
      const endpoint = result.piEndpoints.find((item) => item.id === 'pi:fixture')!;
      expect(endpoint.access?.clientSecret).toBe('');
      expect(endpoint.hasAccessSecret).toBe(true);
      const current = await window.evaluate(() => window.ember.getSettings());
      expect(current.piEndpoints.find((item) => item.id === 'pi:fixture')?.access?.clientSecret).toBe('');
      const stored = await readFile(join(data, 'settings.json'), 'utf8');
      expect(stored).not.toContain(accessSecret);
      expect(JSON.parse(stored).piEndpoints[0].accessEncrypted).toBeTruthy();
      // The saved HTTPS address is still this loopback fixture. Background probes can only fail
      // their TLS handshake locally; the test never resolves or contacts an external host.
    });

    await test.step('inspection while off invokes no command; explicit enable only reaches the fake executable and fails closed', async () => {
      expect((await window.evaluate(() => window.ember.kilnSharing!('inspect'))).state).toBe('off');
      expect(await readFile(calls, 'utf8')).toBe('');
      const enabled = await window.evaluate(() => window.ember.kilnSharing!('enable'));
      expect(enabled.state).toBe('blocked');
      expect(enabled.enabled).toBe(false);
      expect(enabled.message).toMatch(/This computer.*Tailscale/s);
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['status --json']);
      expect(await window.evaluate(() => window.ember.kilnSharingDetails!())).toBeNull();
    });

    await test.step('authenticated remote router cannot return or replace credentials or invoke desktop-only operations', async () => {
      // Use the production router factory on loopback, never production's Tailscale listener.
      // Mirror main.ts's desktop-only filtering; callbacks cross the actual native preload IPC.
      let settings = await window.evaluate(() => window.ember.getSettings());
      remote = createRemoteServer(resolve('dist'), {
        listInstances: () => window.evaluate(() => window.ember.listInstances(false)),
        modelStats: { list: async () => [], observe: async () => [], clear: async () => {} },
        getSettings: () => redactRemoteSettings(settings),
        setSettings: async (patch) => {
          settings = await window.evaluate((patch) => window.ember.setSettings(patch as Parameters<typeof window.ember.setSettings>[0]), withoutDesktopOnlySettings(patch));
          return redactRemoteSettings(settings);
        },
        request: (id, method, path, body) => window.evaluate(({ id, method, path, body }) => window.ember.request(id, method, String(path), body), { id, method, path, body }),
        verifyPassword: (password) => password === 'native-router-fixture-password',
        subscribeEvents: () => () => {}, eventStatus: () => ({}),
      });
      const remoteUrl = await listen(remote);
      const login = await context.request.post(`${remoteUrl}/remote/login`, { data: { password: 'native-router-fixture-password' } });
      expect(login.ok()).toBe(true);
      const preview = await context.request.get(`${remoteUrl}/remote/settings`);
      expect(preview.ok()).toBe(true);
      const previewText = await preview.text();
      expect(previewText).not.toContain(token);
      expect(previewText).not.toContain(accessSecret);
      expect(previewText).not.toContain('native-fixture-client');
      const attemptUrl = `${url}/remote-attempt`;
      const attempted = await context.request.post(`${remoteUrl}/remote/settings`, { data: { piEndpoints: [{ id: 'pi:attacker', label: 'Injected', url: attemptUrl, token: 'remote-secret', access: { clientId: 'id', clientSecret: accessSecret } }] } });
      expect(attempted.ok()).toBe(true);
      const responseText = await attempted.text();
      expect(responseText).not.toContain(token);
      expect(responseText).not.toContain(accessSecret);
      const retained = await window.evaluate(() => window.ember.getSettings());
      expect(retained.piEndpoints.map((item) => item.id)).toEqual(['pi:fixture']);
      expect(retained.piEndpoints[0].token).toBe(token);
      const attemptedRequests = () => requests.filter((item) => item.path.startsWith('/remote-attempt')).length;
      const before = attemptedRequests();
      for (const path of ['/remote/pi/test', '/remote/test-pi-endpoint', '/remote/kiln/sharing', '/remote/kiln/sharing-details']) {
        const rejected = await context.request.post(`${remoteUrl}${path}`, { data: { label: 'Remote attempt', url: attemptUrl, token, action: 'enable' } });
        expect([404, 405]).toContain(rejected.status());
      }
      expect(attemptedRequests()).toBe(before);
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['status --json']);
    });
  } finally {
    await context.close();
    if (remote) await close(remote);
    if (app) await app.close();
    await close(upstream);
    await close(wrongService);
    await rm(home, { recursive: true, force: true });
  }
});
