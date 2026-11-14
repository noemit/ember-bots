import { isolatedNativeEnvironment } from './fixtures/nativeEnvironment';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRemoteServer } from '../electron/remoteServer';
import { hashRemotePassword, verifyRemotePassword } from '../electron/remoteAuth';
import type {} from '../src/types';

const loadPackage = createRequire(resolve('package.json'));

test('real IPC and authenticated remote writes retain every mute across an app restart', async ({ request }) => {
  const home = await mkdtemp(join(tmpdir(), 'ember-native-mute-'));
  const ember = join(home, '.ember');
  const profile = join(home, 'profile');
  const keys = Array.from({ length: 80 }, (_, i) => `offline::${i}`);
  const readMarks = { 'pi:host-a::same': { through: 12, ids: [14] } };
  const upstream = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ conversations: [], models: [], ok: true }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('No isolated upstream port');
  let app: ElectronApplication | undefined;
  const bootstrap = join(home, 'bootstrap.cjs');
  await mkdir(ember, { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(join(ember, 'settings.json'), JSON.stringify({ localHarnessEnabled: false, remoteAccessEnabled: false, readMarks, piEndpoints: [{ id: 'pi:host-a', label: 'Isolated mute fixture', url: 'http://127.0.0.1:' + upstreamAddress.port, token: 'synthetic-fixture-token' }] }));
  await writeFile(bootstrap, `const { app } = require('electron');
if (require('node:os').homedir() !== process.env.EMBER_TEST_HOME) throw new Error('Test home is not isolated');
app.on('browser-window-created', (_event, win) => { win.setFocusable(false); win.hide(); });
app.setPath('userData', process.env.EMBER_TEST_PROFILE);
app.setPath('sessionData', process.env.EMBER_TEST_PROFILE);
require(process.env.EMBER_TEST_ENTRY);
`);
  const env = {
    ...isolatedNativeEnvironment(home),
    HOME: home, OPENCHAMBER_DATA_DIR: join(home, 'openchamber'), EMBER_TEST_HOME: home,
    EMBER_TEST_PROFILE: profile, EMBER_TEST_ENTRY: resolve('dist-electron/main.js'),
  };
  const launch = () => electron.launch({ executablePath: loadPackage('electron') as string, args: [bootstrap], env });
  try {
    app = await launch();
    let window = await app.firstWindow();
    await window.waitForFunction(() => Boolean(window.ember));
    const initial = await window.evaluate(({ keys }) => window.ember.setSettings({ mutedSessions: keys }), { keys });
    expect(initial.mutedSessions).toEqual(keys);
    expect(initial.readMarks).toEqual(readMarks);
    const password = randomBytes(24).toString('hex');
    const hash = await hashRemotePassword(password);
    const remote = createRemoteServer(resolve('dist'), {
      modelStats: { list: async () => [], observe: async () => [], clear: async () => {} },
      listInstances: async () => [],
      getSettings: () => window.evaluate(() => window.ember.getSettings()),
      setSettings: patch => window.evaluate(patch => window.ember.setSettings(patch as Parameters<typeof window.ember.setSettings>[0]), patch),
      request: async () => ({ ok: true, status: 200, data: {} }),
      verifyPassword: value => verifyRemotePassword(value, hash),
      subscribeEvents: () => () => {}, eventStatus: () => ({}),
    });
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
    try {
      const address = remote.address();
      if (!address || typeof address === 'string') throw new Error('No isolated test port');
      const url = `http://127.0.0.1:${address.port}`;
      expect((await request.post(`${url}/remote/settings`, { data: { mutedSessions: [] } })).status()).toBe(401);
      expect((await request.post(`${url}/remote/login`, { data: { password } })).status()).toBe(200);
      const saved = await request.post(`${url}/remote/settings`, { data: { mutedSessions: [...keys, 'pi:host-a::same', 'pi:host-b::same'] } });
      expect(saved.status()).toBe(200);
      expect((await saved.json()).mutedSessions).toHaveLength(82);
      expect((await saved.json()).readMarks).toEqual(readMarks);
      const unmuted = await request.post(`${url}/remote/settings`, { data: { mutedSessions: [...keys, 'pi:host-b::same'] } });
      expect((await unmuted.json()).mutedSessions).toEqual([...keys, 'pi:host-b::same']);
    } finally {
      remote.closeAllConnections();
      await new Promise<void>(resolve => remote.close(() => resolve()));
    }
    expect(JSON.parse(await readFile(join(ember, 'settings.json'), 'utf8')).mutedSessions).toEqual([...keys, 'pi:host-b::same']);
    await app.close();
    app = await launch();
    window = await app.firstWindow();
    await window.waitForFunction(() => Boolean(window.ember));
    const restarted = await window.evaluate(() => window.ember.getSettings());
    expect(restarted.mutedSessions).toEqual([...keys, 'pi:host-b::same']);
    expect(restarted.readMarks).toEqual(readMarks);
    await window.evaluate(() => window.ember.setSettings({ mutedSessions: [] }));
    expect((await window.evaluate(() => window.ember.getSettings())).readMarks).toEqual(readMarks);
  } finally {
    await app?.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
