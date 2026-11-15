import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { hasUpdatePublisher, UpdateController, updateEligibility, type Updater, type UpdateSnapshot } from '../electron/updates';

class MockUpdater extends EventEmitter implements Updater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  channel = 'beta';
  checkForUpdates: Updater['checkForUpdates'] = async () => ({ isUpdateAvailable: true, updateInfo: { version: '1.2.0' } });
  downloadUpdate: Updater['downloadUpdate'] = async () => ['update.zip'];
}
const enabled = updateEligibility({ packaged: true, canary: false, stableDistribution: true, version: '1.1.0', platform: 'darwin' });
function setup(updater = new MockUpdater()) {
  const states: UpdateSnapshot[] = [];
  let restarts = 0;
  const controller = new UpdateController(updater, '1.1.0', enabled, state => states.push(state), () => restarts++);
  return { updater, states, controller, restarted: () => restarts };
}

describe('desktop update controller', () => {
  test('sets stable, manual-download configuration and checks GitHub for stable releases only', async () => {
    const { updater, controller } = setup();
    expect([updater.autoDownload, updater.autoInstallOnAppQuit, updater.allowPrerelease, updater.allowDowngrade, updater.channel])
      .toEqual([false, false, false, false, 'latest']);
    const state = await controller.action('check');
    expect(state).toMatchObject({ phase: 'available', currentVersion: '1.1.0', version: '1.2.0' });
    expect(state.message).toContain('Ember 1.2.0');
    expect(await controller.action('check')).toMatchObject({ phase: 'available' });
  });

  test('sets channel before the policy flags so setter side effects are overwritten', () => {
    const updater = new MockUpdater();
    let channel = 'beta';
    Object.defineProperty(updater, 'channel', {
      configurable: true,
      get: () => channel,
      set: (value: string | null) => {
        channel = value ?? '';
        updater.allowPrerelease = true;
        updater.allowDowngrade = true;
      },
    });
    setup(updater);
    expect(channel).toBe('latest');
    // Controller assigns the channel before these flags, so policy remains safe.
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
  });

  test('reports no update for null, same, older, prerelease, or malformed release versions', async () => {
    const updater = new MockUpdater();
    const { controller } = setup(updater);
    for (const version of [undefined, '1.1.0', '1.0.9', '1.2.0-beta.1', 'latest']) {
      updater.checkForUpdates = async () => version ? ({ isUpdateAvailable: true, updateInfo: { version } }) : null;
      const state = await controller.action('check');
      expect(state).toMatchObject({ phase: 'idle', version: undefined });
      expect(state.message).toContain('Ember');
      expect(state.message).toContain('GitHub');
    }
  });

  test('does not offer a version rejected by platform or staged-rollout eligibility', async () => {
    const updater = new MockUpdater();
    const { controller } = setup(updater);
    updater.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: { version: '1.2.0' } });
    expect(await controller.action('check')).toMatchObject({ phase: 'idle', version: undefined });
    expect(await controller.action('download')).toMatchObject({ phase: 'idle', version: undefined });
  });

  test('downloads only an available release, clamps progress, cleans listeners and gates restart', async () => {
    const { updater, controller, restarted } = setup();
    expect(await controller.action('download')).toMatchObject({ phase: 'idle' });
    await controller.action('check');
    expect(await controller.action('restart')).toMatchObject({ phase: 'available' });
    expect(restarted()).toBe(0);
    updater.downloadUpdate = async () => {
      updater.emit('download-progress', { percent: 38.5 });
      updater.emit('download-progress', { percent: 140 });
      updater.emit('download-progress', { percent: Number.NaN });
      return ['update.zip'];
    };
    const downloaded = await controller.action('download');
    expect(downloaded).toMatchObject({ phase: 'downloaded', progress: 100 });
    expect(downloaded.message).toContain('Ember');
    expect(downloaded.message).toContain('Restart');
    expect(controller.snapshot().progress).toBe(100);
    expect(await controller.action('restart')).toMatchObject({ phase: 'downloaded' });
    expect(restarted()).toBe(1);
    expect(updater.listenerCount('download-progress')).toBe(0);
  });

  test('coalesces concurrent actions and publishes download progress', async () => {
    const updater = new MockUpdater();
    let resolveDownload!: (value: string[]) => void;
    updater.downloadUpdate = () => new Promise(resolve => { resolveDownload = resolve; });
    const { controller } = setup(updater);
    await controller.action('check');
    const first = controller.action('download');
    await Promise.resolve();
    updater.emit('download-progress', { percent: 42 });
    expect(controller.snapshot()).toMatchObject({ phase: 'downloading', progress: 42 });
    expect(await controller.action('download')).toMatchObject({ phase: 'downloading', progress: 42 });
    expect(await controller.action('check')).toMatchObject({ phase: 'downloading', progress: 42 });
    resolveDownload(['update.zip']);
    expect(await first).toMatchObject({ phase: 'downloaded' });
  });

  test('rejected checks and downloads give recovery copy without leaking host errors or secrets; download can retry', async () => {
    const updater = new MockUpdater();
    const { controller } = setup(updater);
    updater.checkForUpdates = async () => { throw new Error('https://private.example/token=SECRET /Users/alice/signing-key'); };
    let state = await controller.action('check');
    expect(state).toMatchObject({ phase: 'error' });
    expect(state.message).toContain('Ember');
    expect(state.message).toContain('GitHub');
    expect(state.message).toContain('Retry');
    expect(state.message).not.toMatch(/SECRET|private\.example|\/Users\/alice|token=/);
    updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '1.2.0' } });
    await controller.action('check');
    updater.downloadUpdate = async () => { throw new Error('SECRET /private/path'); };
    state = await controller.action('download');
    expect(state).toMatchObject({ phase: 'error' });
    expect(state.message).toContain('Ember');
    expect(state.message).toContain('Retry');
    expect(state.message).toContain('Keep using this version');
    expect(state.message).not.toMatch(/SECRET|private\/path/);
    updater.downloadUpdate = async () => ['update.zip'];
    expect(await controller.action('download')).toMatchObject({ phase: 'downloaded' });
  });

  test('prepares native mac signature only on explicit restart; preparation rejection blocks restart', async () => {
    const updater = new MockUpdater();
    const states: UpdateSnapshot[] = [];
    let restarts = 0;
    let preparations = 0;
    const controller = new UpdateController(updater, '1.1.0', enabled, state => states.push(state), () => restarts++, async () => {
      preparations++;
      throw new Error('private signing path /Users/alice/key');
    });
    await controller.action('check');
    const downloaded = await controller.action('download');
    expect(downloaded).toMatchObject({ phase: 'downloaded' });
    expect(downloaded.message).toContain('Restart');
    expect(preparations).toBe(0);
    const state = await controller.action('restart');
    expect(state).toMatchObject({ phase: 'error' });
    expect(state.message).toContain('Ember');
    expect(state.message).toContain('Retry');
    expect(state.message).not.toMatch(/private signing path|alice|key/);
    expect(preparations).toBe(1);
    expect(restarts).toBe(0);
  });

  test('contains updater error events and dispose prevents later publications', async () => {
    const { updater, controller, states } = setup();
    expect(() => updater.emit('error', new Error('provider diagnostic'))).not.toThrow();
    controller.dispose();
    const before = states.length;
    await controller.action('check');
    expect(states).toHaveLength(before);
    expect(updater.listenerCount('error')).toBe(0);
  });

  test('requires the stable release distribution marker even for packaged stable-version builds', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(updateEligibility({ packaged: true, canary: false, version: '1.1.0', platform, windowsInstalled: true, appImage: '/tmp/Ember.AppImage' }))
        .toMatchObject({ enabled: false, supported: false, message: expect.stringContaining('development') });
    }
  });

  test('accepts only non-empty publisher names and arrays of non-empty publisher names', () => {
    expect(hasUpdatePublisher({ publisherName: 'Example Publisher' })).toBe(true);
    expect(hasUpdatePublisher({ publisherName: ['Publisher One', 'Publisher Two'] })).toBe(true);
    for (const config of [undefined, null, {}, 'publisher', { publisherName: undefined }, { publisherName: '' }, { publisherName: '  ' }, { publisherName: [] }, { publisherName: ['Publisher', ''] }, { publisherName: ['Publisher', null] }, { publisherName: 12 }]) {
      expect(hasUpdatePublisher(config)).toBe(false);
    }
  });

  test('disables dev, Canary, preview and unsupported stable Linux installs with helpful guidance', () => {
    for (const options of [
      { packaged: false, canary: false, version: '1.1.0', platform: 'darwin' },
      { packaged: true, canary: true, stableDistribution: true, version: '1.1.0', platform: 'darwin' },
      { packaged: true, canary: false, version: '1.1.0', platform: 'darwin' },
      { packaged: true, canary: false, stableDistribution: true, version: '1.1.0-beta.1', platform: 'win32' },
    ]) expect(updateEligibility(options)).toMatchObject({ enabled: false, supported: false, message: expect.stringContaining('Ember') });
    const linux = updateEligibility({ packaged: true, canary: false, stableDistribution: true, version: '1.1.0', platform: 'linux' });
    expect(linux.enabled).toBe(false);
    expect(linux.supported).toBe(false);
    expect(linux.message?.includes('package manager')).toBe(true);
    expect(linux.message?.includes('GitHub')).toBe(true);
    expect(updateEligibility({ packaged: true, canary: false, stableDistribution: true, version: '1.1.0', platform: 'linux', appImage: '/tmp/Ember.AppImage' }))
      .toMatchObject({ enabled: true, supported: true });
    expect(updateEligibility({ packaged: true, canary: false, stableDistribution: true, version: '1.1.0', platform: 'win32' })).toMatchObject({ enabled: false, supported: false, message: expect.stringContaining('NSIS') });
    expect(updateEligibility({ packaged: true, canary: false, stableDistribution: true, version: '1.1.0', platform: 'win32', windowsInstalled: true })).toMatchObject({ enabled: true, supported: true });
  });

  test('keeps update IPC desktop-only and validates trusted sender and action at main boundary', () => {
    const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
    const preload = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
    expect(main).toContain("ipcMain.handle('ember:updates:state', (event)");
    expect(main).toContain("ipcMain.handle('ember:updates:action', (event, action: unknown)");
    expect(main).toContain('assertTrustedSender(event);');
    expect(main).toContain("!['check', 'download', 'restart'].includes(String(action))");
    expect(preload).toContain('desktopUpdates: true');
    expect(preload).toContain("ipcRenderer.invoke('ember:updates:state')");
    expect(preload).toContain("ipcRenderer.invoke('ember:updates:action', action)");
    expect(main).not.toMatch(/remote[^\n]{0,80}updates:action/i);
  });
});

test('automatic update failures and no-update checks stay quiet; available updates still notify', async () => {
  const { controller, updater, states } = setup();
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  await controller.action('check', true);
  expect(controller.snapshot().phase).toBe('idle');
  expect(states).toEqual([]);
  updater.checkForUpdates = async () => null;
  await controller.action('check', true);
  expect(states).toEqual([]);
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '1.3.0' } });
  await controller.action('check', true);
  expect(states.map(state => state.phase)).toEqual(['available']);
});
