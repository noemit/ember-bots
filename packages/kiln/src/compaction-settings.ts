import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Models } from '@earendil-works/pi-ai';
import type { CompactionSettings as PiCompactionSettings } from '@earendil-works/pi-durable';
import { tightenPermissions } from './permissions';

/** Confirmed against pi-durable 1.5.0's compiled agent.js, not README examples. */
export const PI_COMPACTION_DEFAULTS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 };
export type CompactionPreference = { compactAtTokens: number; keepRecentTokens: number };
export function validateCompactionPreference(value: unknown): CompactionPreference | undefined {
  if (value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose token counts, or Reset to Pi defaults.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'compactAtTokens' && key !== 'keepRecentTokens')) throw new Error('Only the compaction threshold and recent context can be changed here.');
  const { compactAtTokens, keepRecentTokens } = record;
  if (typeof compactAtTokens !== 'number' || !Number.isSafeInteger(compactAtTokens) || compactAtTokens < 1024 || compactAtTokens > 10000000) throw new Error('Compact at must be a whole token count between 1,024 and 10,000,000.');
  if (typeof keepRecentTokens !== 'number' || !Number.isSafeInteger(keepRecentTokens) || keepRecentTokens < 1 || keepRecentTokens >= compactAtTokens) throw new Error('Keep recent must be a positive whole token count smaller than Compact at.');
  return { compactAtTokens, keepRecentTokens };
}

export function effectiveCompaction(preference: CompactionPreference, contextWindow: number) {
  const blockingAtTokens = contextWindow - PI_COMPACTION_DEFAULTS.reserveTokens;
  if (!Number.isSafeInteger(contextWindow) || blockingAtTokens <= 1) return undefined;
  const compactAtTokens = Math.min(preference.compactAtTokens, blockingAtTokens);
  // Leave at least half of a smaller model's usable input for its summary/system prompt.
  const keepRecentTokens = Math.min(preference.keepRecentTokens, Math.floor(compactAtTokens / 2));
  return { compactAtTokens, keepRecentTokens, blockingAtTokens,
    reserveTokens: PI_COMPACTION_DEFAULTS.reserveTokens,
    backgroundTokens: blockingAtTokens - compactAtTokens };
}

/** Only these two numbers are persisted. No agent state, providers, keys or YOLO policy. */
export class CompactionSettings {
  private preference?: CompactionPreference;
  private readonly file: string;
  constructor(private readonly home: string, private readonly models: Pick<Models, 'getModels'>) {
    this.file = join(home, 'compaction.json');
    try { this.preference = validateCompactionPreference(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const quarantined = `${this.file}.corrupt-${Date.now()}`;
        try {
          renameSync(this.file, quarantined);
          console.warn(`[hearth] Kiln could not read compaction.json; kept the unreadable file at ${quarantined} and fell back to Pi defaults.`);
        } catch {
          console.warn('[hearth] Kiln could not read compaction.json; falling back to Pi defaults.');
        }
        this.preference = undefined;
      }
    }
  }
  state() {
    return { preference: this.preference ?? null, defaults: PI_COMPACTION_DEFAULTS,
      models: this.models.getModels().map(model => {
        const effective = this.preference ? effectiveCompaction(this.preference, model.contextWindow) : undefined;
        return { provider: model.provider, modelId: model.id, contextWindow: model.contextWindow,
          compactAtTokens: effective?.compactAtTokens ?? Math.max(0, model.contextWindow - 16384 - 32768),
          keepRecentTokens: effective?.keepRecentTokens ?? 20000,
          blockingAtTokens: effective?.blockingAtTokens ?? Math.max(0, model.contextWindow - 16384),
          custom: Boolean(effective), supported: model.contextWindow > 16385 };
      }) };
  }
  /** Harness calls this at every use, including model switches and newly discovered catalogs. */
  settings(): { compaction?: PiCompactionSettings } {
    if (!this.preference) return {};
    const modelOverrides: Record<string, Partial<typeof PI_COMPACTION_DEFAULTS>> = {};
    for (const model of this.models.getModels()) {
      const effective = effectiveCompaction(this.preference, model.contextWindow);
      if (effective) modelOverrides[`${model.provider}/${model.id}`] = {
        reserveTokens: effective.reserveTokens, backgroundTokens: effective.backgroundTokens,
        keepRecentTokens: effective.keepRecentTokens,
      };
    }
    return { compaction: { modelOverrides } };
  }
  save(value: unknown) {
    const preference = validateCompactionPreference(value);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    tightenPermissions(this.home, 0o700);
    const tmp = this.file + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(preference ?? null) + '\n', { mode: 0o600 });
      tightenPermissions(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch { throw new Error('Kiln could not write its compaction settings. Check its data-folder permissions, then try Save again.'); }
    this.preference = preference;
    return this.state();
  }
}
