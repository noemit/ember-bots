import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const loadPackage = createRequire(resolve('package.json'));
test('update IPC is disabled in development and rejects an untrusted renderer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ember-updates-native-'));
  await mkdir(join(home, '.ember'));
  await mkdir(join(home, 'openchamber'));
  await writeFile(join(home, '.ember/settings.json'), JSON.stringify({ localHarnessEnabled: false }));
  await writeFile(join(home, 'openchamber/settings.json'), JSON.stringify({ desktopHosts: [] }));
  const bootstrap = join(home, 'bootstrap.cjs');
  await writeFile(bootstrap, `const { app } = require('electron');
app.setPath('userData', process.env.EMBER_TEST_PROFILE);
app.setPath('sessionData', process.env.EMBER_TEST_PROFILE);
require(process.env.EMBER_TEST_ENTRY);`);
  const env = { ...process.env, HOME: home, EMBER_DATA_DIR: join(home, '.ember'), OPENCHAMBER_DATA_DIR: join(home, 'openchamber'), EMBER_TEST_PROFILE: join(home, 'profile'), EMBER_TEST_ENTRY: resolve('dist-electron/main.js') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: loadPackage('electron') as string, args: [bootstrap], env });
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(async () => (await window.ember.getUpdateState?.())?.phase)).toBe('disabled');
    expect(await page.evaluate(async () => (await window.ember.updateAction?.('restart'))?.phase)).toBe('disabled');
    const rejected = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const probe = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
      try {
        await probe.loadURL('data:text/html,<title>Untrusted update IPC probe</title>');
        return await probe.webContents.executeJavaScript(`Promise.all(['check','download','restart'].map(action => window.ember.updateAction(action).then(() => false, () => true)))`);
      } finally { probe.destroy(); }
    }, resolve('dist-electron/preload.js'));
    expect(rejected).toEqual([true, true, true]);
  } finally { await app.close(); await rm(home, { recursive: true, force: true }); }
});
