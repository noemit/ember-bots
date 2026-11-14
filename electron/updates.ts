import type { EventEmitter } from 'node:events';

export type UpdateSnapshot = {
  phase: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  version?: string;
  progress?: number;
  message?: string;
  supported: boolean;
};
export type UpdateAction = 'check' | 'download' | 'restart';
export type Updater = Pick<EventEmitter, 'on' | 'removeListener'> & {
  autoDownload: boolean; autoInstallOnAppQuit: boolean; allowPrerelease: boolean; allowDowngrade: boolean;
  channel: string | null; checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<string[]>;
};
export function updateEligibility(options: { packaged: boolean; canary: boolean; version: string; stableDistribution?: boolean; platform: string; appImage?: string; windowsInstalled?: boolean }): { enabled: boolean; supported: boolean; message?: string } {
  if (!options.packaged || !options.stableDistribution || options.canary || !/^\d+\.\d+\.\d+$/.test(options.version)) return { enabled: false, supported: false, message: 'Ember updates are off in development, Canary and preview builds. Install the stable desktop release to receive updates.' };
  if (options.platform === 'win32' && !options.windowsInstalled) return { enabled: false, supported: false, message: 'This Ember ZIP copy cannot install updates. Download and run the NSIS setup from GitHub Releases to enable updates.' };
  if (!['darwin', 'win32'].includes(options.platform) && !(options.platform === 'linux' && options.appImage)) return { enabled: false, supported: false, message: 'This Ember package cannot install updates. Use your package manager or download the latest release from GitHub.' };
  return { enabled: true, supported: true };
}
export function hasUpdatePublisher(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const value = (config as { publisherName?: unknown }).publisherName;
  const names = Array.isArray(value) ? value : [value];
  return names.length > 0 && names.every((name) => typeof name === 'string' && name.trim().length > 0);
}
function newer(current: string, next: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(next)) return false;
  const a = current.split('.').map(Number), b = next.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return b[i] > a[i]; }
  return false;
}
/** No host/provider diagnostics cross IPC: URLs and signing failures may contain private paths. */
export class UpdateController {
  private state: UpdateSnapshot;
  private busy = false;
  private disposed = false;
  private readonly swallowError = () => {
    if (!this.busy && this.state.phase === 'downloaded') this.publish({ phase: 'error', message: 'Ember could not start the update installer. Keep using this version, then choose Retry.' });
  };
  constructor(private readonly updater: Updater | undefined, version: string, eligibility: ReturnType<typeof updateEligibility>, private readonly changed: (state: UpdateSnapshot) => void, private readonly restart: () => void, private readonly prepare: () => Promise<void> = async () => {}) {
    this.state = { phase: eligibility.enabled ? 'idle' : 'disabled', currentVersion: version, supported: eligibility.supported, ...(eligibility.message ? { message: eligibility.message } : {}) };
    if (updater) {
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.channel = 'latest';
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      // electron-updater emits error AND rejects the operation; the promise owns state transitions.
      updater.on('error', this.swallowError);
    }
  }
  snapshot(): UpdateSnapshot { return { ...this.state }; }
  private publish(patch: Partial<UpdateSnapshot>) { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.changed(this.snapshot()); }
  async action(action: UpdateAction): Promise<UpdateSnapshot> {
    if (this.disposed || !this.updater || this.state.phase === 'disabled' || this.busy) return this.snapshot();
    if (action === 'restart') {
      if (this.state.phase !== 'downloaded') return this.snapshot();
      this.busy = true;
      try {
        // Native macOS staging can install on a later quit. Do it only after explicit confirmation,
        // and before stopping any owned Kiln; an invalid signature must not interrupt running chats.
        await this.prepare();
        this.restart();
      } catch {
        this.publish({ phase: 'error', message: 'Ember could not prepare or verify the update for restart. Keep working, then choose Retry.' });
      } finally { this.busy = false; }
      return this.snapshot();
    }
    if (action === 'download' && (!this.state.version || !['available', 'error'].includes(this.state.phase))) return this.snapshot();
    if (action === 'check' && ['downloaded', 'available'].includes(this.state.phase)) return this.snapshot();
    this.busy = true;
    const progress = (value: { percent?: number }) => { if (typeof value.percent === 'number' && Number.isFinite(value.percent)) this.publish({ progress: Math.max(0, Math.min(100, value.percent)) }); };
    try {
      if (action === 'check') {
        this.publish({ phase: 'checking', version: undefined, progress: undefined, message: 'Ember is checking GitHub for a stable update…' });
        const result = await this.updater.checkForUpdates();
        const version = result?.updateInfo.version;
        if (result?.isUpdateAvailable === true && version && newer(this.state.currentVersion, version)) this.publish({ phase: 'available', version, message: `Ember ${version} is ready to download.` });
        else this.publish({ phase: 'idle', message: 'Ember is up to date with the stable GitHub release.' });
      } else {
        this.publish({ phase: 'downloading', progress: 0, message: 'Ember is downloading and verifying the update…' });
        this.updater.on('download-progress', progress);
        await this.updater.downloadUpdate();
        this.publish({ phase: 'downloaded', progress: 100, message: 'Ember has downloaded and checked the update. Choose Restart and install when you are ready; macOS verifies its signature before Ember stops its bundled Kiln.' });
      }
    } catch {
      this.publish({ phase: 'error', progress: undefined, message: action === 'check' ? 'Ember could not check GitHub for updates. Check your connection, then choose Retry.' : 'Ember could not download or verify this update. Keep using this version, then choose Retry.' });
    } finally { this.updater.removeListener('download-progress', progress); this.busy = false; }
    return this.snapshot();
  }
  dispose() { this.disposed = true; this.updater?.removeListener('error', this.swallowError); }
}
