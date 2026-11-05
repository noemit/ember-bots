import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type ModelObservation = {
  id: string;
  instanceId: string;
  sessionId: string;
  messageId: string;
  providerID: string;
  modelID: string;
  variant?: string;
  directory?: string;
  completedAt: number;
  durationMs?: number;
  output?: number;
  prompt?: number;
  cacheRead?: number;
  cost?: number;
  error: boolean;
  aborted: boolean;
};

const RETENTION_MS = 90 * 24 * 60 * 60_000;
const text = (value: unknown, limit = 500): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0') ? value : undefined;
const number = (value: unknown, limit = 1e12): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= limit ? value : undefined;

export const parseObservation = (value: unknown, now = Date.now()): ModelObservation | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const instanceId = text(raw.instanceId);
  const sessionId = text(raw.sessionId);
  const messageId = text(raw.messageId);
  const providerID = text(raw.providerID, 200);
  const modelID = text(raw.modelID, 200);
  const completedAt = number(raw.completedAt, Number.MAX_SAFE_INTEGER);
  if (!instanceId || !sessionId || !messageId || !providerID || !modelID || completedAt === undefined || completedAt < now - RETENTION_MS || completedAt > now + 86_400_000) return null;
  return {
    id: JSON.stringify([instanceId, sessionId, messageId]), instanceId, sessionId, messageId, providerID, modelID,
    variant: text(raw.variant, 80), directory: text(raw.directory, 2048), completedAt,
    durationMs: number(raw.durationMs), output: number(raw.output), prompt: number(raw.prompt),
    cacheRead: number(raw.cacheRead), cost: number(raw.cost), error: raw.error === true, aborted: raw.aborted === true,
  };
};

export class ModelStatsStore {
  private records = new Map<string, ModelObservation>();
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private clearedAt = 0;
  private dirty = false;
  private saveRevision = 0;
  /** Set when an unreadable file could not be quarantined; saving would destroy it. */
  private writesDisabled = false;

  constructor(private readonly file: string) {}

  /**
   * Read once per process, and never memoise a failure.
   *
   * `this.loaded` used to hold the *rejected* promise when the file did not parse, so `list`,
   * `observe`, `rate` and `clear` all rejected for the rest of the process — and `clear()` is the
   * one action that would have fixed it. The file is now moved aside and the store starts empty;
   * a failure that is not the file's fault (a locked directory) clears `loaded` so the next call
   * tries again instead of bricking the feature.
   */
  private load(): Promise<void> {
    this.loaded ??= this.read().catch((error) => {
      this.loaded = undefined;
      throw error;
    });
    return this.loaded;
  }

  private async read(): Promise<void> {
    let contents: string;
    try {
      contents = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
    let raw: { clearedAt?: unknown; observations?: unknown[] };
    try {
      const parsed: unknown = JSON.parse(contents);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an observations file');
      raw = parsed as { clearedAt?: unknown; observations?: unknown[] };
    } catch (error) {
      await this.quarantine(error);
      return;
    }
    this.clearedAt = number(raw.clearedAt, Number.MAX_SAFE_INTEGER) ?? 0;
    for (const value of (Array.isArray(raw.observations) ? raw.observations : []).slice(-10_000)) {
      const observation = parseObservation(value);
      if (!observation || observation.completedAt <= this.clearedAt) continue;
      this.records.set(observation.id, observation);
    }
  }

  /**
   * Keep an unreadable file instead of overwriting it, and carry on with an empty store.
   *
   * If even the rename fails, stop writing: the old bytes are the only copy of the observations, and a
   * save would replace them with an empty list.
   */
  private async quarantine(error: unknown): Promise<void> {
    const target = `${this.file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(this.file, target);
      console.warn(`Model experience file could not be read (${error instanceof Error ? error.message : 'invalid JSON'}); kept it at ${target}`);
    } catch (renameError) {
      this.writesDisabled = true;
      console.error('Model experience file could not be read and could not be moved aside; leaving it untouched', renameError);
    }
    this.clearedAt = 0;
    this.records.clear();
  }

  async list(): Promise<ModelObservation[]> {
    await this.load();
    const cutoff = Date.now() - RETENTION_MS;
    for (const [key, record] of this.records) if (record.completedAt < cutoff) this.records.delete(key);
    return [...this.records.values()].sort((a, b) => b.completedAt - a.completedAt);
  }

  async observe(values: unknown): Promise<ModelObservation[]> {
    await this.load();
    if (!Array.isArray(values)) throw new Error('Invalid model observations');
    let changed = false;
    const accepted = new Set<string>();
    const confirmed = () => [...accepted].flatMap((id) => {
      const record = this.records.get(id);
      return record ? [record] : [];
    });
    for (const value of values.slice(-10_000)) {
      const observation = parseObservation(value);
      if (!observation || observation.completedAt <= this.clearedAt) continue;
      accepted.add(observation.id);
      const previous = this.records.get(observation.id);
      if (JSON.stringify(previous) === JSON.stringify(observation)) continue;
      this.records.set(observation.id, observation);
      changed = true;
    }
    if (!changed) {
      if (this.dirty) await this.save();
      return confirmed();
    }
    const retained = [...this.records.values()].filter((record) => record.completedAt >= Date.now() - RETENTION_MS)
      .sort((a, b) => b.completedAt - a.completedAt).slice(0, 10_000);
    this.records = new Map(retained.map((record) => [record.id, record]));
    await this.save();
    return confirmed();
  }

  async clear(): Promise<void> {
    await this.load();
    this.clearedAt = Date.now();
    this.records.clear();
    await this.save();
  }

  private save(): Promise<void> {
    if (this.writesDisabled) return Promise.resolve();
    this.dirty = true;
    const revision = ++this.saveRevision;
    const contents = JSON.stringify({ clearedAt: this.clearedAt, observations: [...this.records.values()] });
    this.writes = this.writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, contents, { mode: 0o600 });
      await fs.rename(temporary, this.file);
      if (revision === this.saveRevision) this.dirty = false;
    });
    return this.writes;
  }
}
