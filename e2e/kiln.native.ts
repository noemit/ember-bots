import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type {} from '../src/types';

const load = createRequire(resolve('package.json'));
const binary = resolve('build/harness', process.platform === 'win32' ? 'kiln.exe' : 'kiln');
const tinder = resolve('release', process.platform === 'win32' ? 'tinder-cli.exe' : 'tinder-cli');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const launch = async (home: string, override = binary): Promise<ElectronApplication> => {
  const profile = join(home, 'profile');
  await mkdir(profile, { recursive: true });
  const env = { ...process.env, HOME: home, EMBER_DATA_DIR: profile,
    EMBER_BUNDLED_HARNESS: override, OPENCHAMBER_DATA_DIR: join(home, 'openchamber'),
    HEARTH_AUTORELOAD: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  // Separate Chromium profiles let two isolated Ember instances run simultaneously.
  const bootstrap = join(home, 'bootstrap.cjs');
  await writeFile(bootstrap, `const { app } = require('electron');
app.on('browser-window-created', (_event, win) => win.setFocusable(false));
app.setPath('userData', ${JSON.stringify(join(home, 'chromium'))});
require(${JSON.stringify(resolve('dist-electron/main.js'))});
`);
  return electron.launch({ executablePath: load('electron') as string, args: [bootstrap], env });
};

const local = async (app: ElectronApplication) => {
  const window = await app.firstWindow();
  await expect.poll(() => window.evaluate(async () => (await window.ember.getSettings()).localHarnessState?.kind))
    .toBe('started');
  return window.evaluate(async () => (await window.ember.getSettings()).piEndpoints.find((item) => item.id === 'pi:local')!);
};

test('Retry starts a missing bundled Kiln; isolated profiles have different ports and quit stops each child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ember-kiln-native-'));
  const home = join(root, 'first');
  const otherHome = join(root, 'second');
  const missing = join(root, 'kiln');
  let app: ElectronApplication | undefined;
  let other: ElectronApplication | undefined;
  let pid: number | undefined;
  let otherPid: number | undefined;
  try {
    // A fresh canary must not discover credentials from the daily profile.
    await mkdir(join(home, '.ember'), { recursive: true });
    await writeFile(join(home, '.ember', 'hearth.token'), 'daily-profile-token');
    app = await launch(home, missing);
    const window = await app.firstWindow();
    await expect(window.getByTestId('onboarding')).toBeVisible();
    await window.getByRole('button', { name: /Where to run Kiln/ }).click();
    await expect(window.getByText(/Kiln is not ready/)).toBeVisible();
    expect(await window.evaluate(async () => (await window.ember.getSettings()).piEndpoints)).toEqual([]);
    await symlink(binary, missing);
    await window.getByRole('button', { name: 'Retry', exact: true }).click();
    const endpoint = await local(app);
    pid = JSON.parse(await readFile(join(home, 'profile', 'ember-harness.lock'), 'utf8')).pid;
    const response = await fetch(`${endpoint.url}/health`, { headers: { authorization: `Bearer ${endpoint.token}` } });
    expect(response.status).toBe(200);
    expect((await response.json()).version).toBe(load('./packages/kiln/package.json').version);

    other = await launch(otherHome);
    const otherEndpoint = await local(other);
    const otherWindow = await other.firstWindow();
    await expect(otherWindow.getByTestId('onboarding')).toBeVisible();
    expect(await otherWindow.evaluate(async () => Boolean((await window.ember.getSettings()).onboardedAt))).toBe(false);
    await otherWindow.reload();
    await expect(otherWindow.getByTestId('onboarding')).toBeVisible();
    await otherWindow.getByRole('button', { name: /Ember and Kiln/ }).click();
    const diagram = otherWindow.getByRole('figure', { name: /Ember.*included Kiln.*other computers/ });
    await expect(diagram).toBeVisible();
    for (const host of ['Container', 'Mac Studio', 'Old PC']) await expect(diagram.getByText(host, { exact: true })).toBeVisible();
    const introduction = await otherWindow.getByTestId('onboarding').innerText();
    expect(introduction).not.toMatch(/\b(instance|harness|GUI|credential|NAS|durable)\b/i);
    expect(introduction).toMatch(/Ember.*direct|direct.*Ember/s);
    expect(introduction).toMatch(/Kiln.*work/s);
    const textSizes = await diagram.locator('div, p, figcaption').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)));
    expect(textSizes.every(size => size >= 16)).toBe(true);
    const introTextSizes = await otherWindow.getByTestId('onboarding').locator('p').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)));
    expect(introTextSizes.every(size => size >= 16)).toBe(true);
    const emberWeight = await otherWindow.locator('strong').filter({ hasText: /^Ember$/ }).evaluate(node => parseInt(getComputedStyle(node).fontWeight));
    expect(emberWeight).toBeGreaterThanOrEqual(600);
    await otherWindow.screenshot({ path: test.info().outputPath('onboarding-diagram.png') });
    await otherWindow.getByRole('button', { name: /Where to run Kiln/ }).click();
    await expect(otherWindow.getByText('Connected to this computer', { exact: true })).toBeVisible();
    const tailscale = otherWindow.locator('details').filter({ has: otherWindow.locator('summary', { hasText: 'Connect over Tailscale' }) });
    expect(await tailscale.getAttribute('open')).toBeNull();
    await tailscale.locator('summary').click();
    await expect(tailscale.getByRole('button', { name: 'Copy setup prompt' })).toBeVisible();
    await tailscale.getByRole('button', { name: 'Copy setup prompt' }).click();
    await expect(tailscale.getByRole('status')).toHaveText('Copied');
    await otherWindow.screenshot({ path: test.info().outputPath('onboarding-where.png') });
    otherPid = JSON.parse(await readFile(join(otherHome, 'profile', 'ember-harness.lock'), 'utf8')).pid;
    expect(otherEndpoint.url).not.toBe(endpoint.url);
    expect(otherEndpoint.token).not.toBe(endpoint.token);
    await app.close(); app = undefined;
    await expect.poll(() => alive(pid!)).toBe(false);
    expect(alive(otherPid!)).toBe(true);
    await other.close(); other = undefined;
    await expect.poll(() => alive(otherPid!)).toBe(false);
  } finally {
    if (app) await app.close();
    if (other) await other.close();
    for (const child of [pid, otherPid]) if (child && alive(child)) process.kill(child, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('standalone Tinder serves without Bun on PATH and survives quitting a connected Ember', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ember-tinder-native-'));
  const backendHome = join(root, 'backend');
  const home = join(root, 'desktop');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let app: ElectronApplication | undefined;
  try {
    const printed = spawnSync(tinder, ['token', '--json', '--home', backendHome, '--port', String(port)], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root, PATH: '' },
    });
    expect(printed.status).toBe(0);
    expect(JSON.parse(printed.stdout).localUrl).toBe(url);
    const service = spawnSync(tinder, ['service-config', '--platform', 'darwin', '--home', backendHome, '--port', String(port)], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root, PATH: '' },
    });
    expect(service.status).toBe(0);
    expect(service.stdout.trimStart()).toMatch(/^<\?xml/);
    expect(service.stdout).toContain(tinder);
    expect(service.stdout).not.toContain('$bunfs');
    if (process.platform === 'darwin') {
      expect(spawnSync('/usr/bin/plutil', ['-lint', '-'], { input: service.stdout }).status).toBe(0);
    }
    child = spawn(tinder, ['serve', '--home', backendHome, '--port', String(port), '--workspace', root], {
      cwd: root, stdio: 'ignore', env: { ...process.env, HOME: root, PATH: '', HEARTH_BIND: '127.0.0.1', HEARTH_AUTORELOAD: '0' },
    });
    let token = '';
    await expect.poll(async () => {
      try {
        token = (await readFile(join(backendHome, 'hearth.token'), 'utf8')).trim();
        return (await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` } })).status;
      } catch { return 0; }
    }).toBe(200);
    await mkdir(join(home, 'profile'), { recursive: true });
    await writeFile(join(home, 'profile', 'settings.json'), JSON.stringify({
      piEndpoints: [{ id: 'pi:tinder', label: 'Standalone', url, token }],
    }));
    app = await launch(home);
    const window = await app.firstWindow();
    await expect.poll(() => window.evaluate(async () => {
      const instances = await window.ember.listInstances(true) as { id: string; status: string }[];
      return instances.find((item) => item.id === 'pi:tinder')?.status;
    })).toBe('ready');
    await app.close(); app = undefined;
    expect(child.exitCode).toBeNull();
    expect((await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  } finally {
    if (app) await app.close();
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child!.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
