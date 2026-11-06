/**
 * Durable activity log: one JSONL line per interesting instance event, one file per local
 * day (`~/.ember/activity/activity-YYYY-MM-DD.jsonl`, mode 0600). Main is the single
 * writer so a desktop window and a remote web client can't double-record, and the log keeps
 * filling while the window is closed. Entries come from `describeEvent` in `eventStream.ts`
 * — the bounded summary main extracted from the event payload, never transcript content.
 *
 * JSONL is append-only and crash-safe (no read-modify-write of a growing file). Appends are
 * buffered in memory and flushed on a short interval and on quit; a failed flush re-buffers
 * its entries so a transient disk error retries instead of silently dropping history.
 */
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as path from 'node:path';
import type { EmberEvent } from './eventStream';

export type ActivityEntry = {
  id: string;
  at: number;
  instanceId: string;
  directory?: string;
  sessionId?: string;
  type: string;
  summary: string;
  detail?: Record<string, string>;
};

export type ActivityQuery = {
  /** A specific local day (`YYYY-MM-DD`); omit for newest-first across all days. */
  day?: string;
  from?: number;
  to?: number;
  limit?: number;
  cursor?: string;
};

export type ActivityPage = { entries: ActivityEntry[]; cursor?: string };

const DAY_FILE = /^activity-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_DAY_BYTES = 5 * 1024 * 1024;
/** How many ids we remember for de-dupe (a reconnect must not double-record a burst). */
const MAX_REMEMBERED_IDS = 4000;
/** Upper bound for entries re-buffered after a failed flush. */
const MAX_RETRIED_ENTRIES = 1000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

const text = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0') ? value : undefined;

const finiteAt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/** A trusted `ActivityEntry` from untrusted persisted JSON; malformed lines are dropped. */
export const parseActivityEntry = (value: unknown): ActivityEntry | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id, 200);
  const at = finiteAt(raw.at);
  const instanceId = text(raw.instanceId, 200);
  const type = text(raw.type, 100);
  const summary = text(raw.summary, 400);
  if (!id || at === undefined || !instanceId || !type || !summary) return null;
  const detailSource =
    raw.detail && typeof raw.detail === 'object' && !Array.isArray(raw.detail)
      ? (raw.detail as Record<string, unknown>)
      : {};
  let detail: Record<string, string> | undefined;
  for (const [key, value2] of Object.entries(detailSource).slice(0, 8)) {
    const name = text(key, 40);
    const content = text(value2, 400);
    if (!name || content === undefined) continue;
    (detail ??= {})[name] = content;
  }
  return {
    id,
    at,
    instanceId,
    directory: text(raw.directory, 2048),
    sessionId: text(raw.sessionId, 200),
    type,
    summary,
    detail,
  };
};

/** The local calendar day an event belongs to; day files are named after it. */
export const dayKeyOf = (at: number): string => {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

/** A trusted entry from a live (or untrusted bridged) event, with a bounded fallback id. */
const entryFromEvent = (event: EmberEvent, now: number): ActivityEntry | null => {
  const summary = text(event.summary, 400);
  const instanceId = text(event.instanceId, 200);
  const type = text(event.type, 100);
  if (!summary || !instanceId || !type) return null;
  const at = finiteAt(event.at) ?? now;
  const id =
    text(event.id, 200) ??
    `${instanceId}:${type}:${event.sessionId ? event.sessionId.slice(0, 200) : ''}:${at}`;
  const detailSource =
    event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
      ? (event.detail as Record<string, unknown>)
      : {};
  let detail: Record<string, string> | undefined;
  for (const [key, value] of Object.entries(detailSource).slice(0, 8)) {
    const name = text(key, 40);
    const content = text(value, 400);
    if (!name || content === undefined) continue;
    (detail ??= {})[name] = content;
  }
  return {
    id,
    at,
    instanceId,
    directory: text(event.directory, 2048),
    sessionId: text(event.sessionId, 200),
    type,
    summary,
    detail,
  };
};

const parseCursor = (cursor: unknown): number => (/^\d+$/.test(String(cursor)) ? Number(cursor) : 0);

/** A trusted query from untrusted IPC input; every field is validated, not coerced. */
export const parseActivityQuery = (value: unknown): ActivityQuery => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const day = typeof raw.day === 'string' && DAY_KEY.test(raw.day) ? raw.day : undefined;
  const from =
    typeof raw.from === 'number' && Number.isFinite(raw.from) && raw.from > 0 ? raw.from : undefined;
  const to = typeof raw.to === 'number' && Number.isFinite(raw.to) && raw.to > 0 ? raw.to : undefined;
  const limit =
    typeof raw.limit === 'number' && Number.isFinite(raw.limit) && raw.limit > 0 && raw.limit <= 100_000
      ? Math.round(raw.limit)
      : undefined;
  const cursor = typeof raw.cursor === 'string' && /^\d+$/.test(raw.cursor) ? raw.cursor : undefined;
  return { day, from, to, limit, cursor };
};

export class ActivityLog {
  private readonly now: () => number;
  private readonly retentionDays: number;
  private readonly flushIntervalMs: number;
  private readonly maxDayBytes: number;
  private buffer: ActivityEntry[] = [];
  private readonly recentIds = new Set<string>();
  private recentOrder: string[] = [];
  private readonly truncatedDays = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly directory: string,
    options: {
      now?: () => number;
      retentionDays?: number;
      flushIntervalMs?: number;
      maxDayBytes?: number;
    } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.retentionDays =
      typeof options.retentionDays === 'number' && options.retentionDays > 0
        ? Math.round(options.retentionDays)
        : DEFAULT_RETENTION_DAYS;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxDayBytes = options.maxDayBytes ?? DEFAULT_MAX_DAY_BYTES;
  }

  private fileFor(day: string): string {
    return path.join(this.directory, `activity-${day}.jsonl`);
  }

  /** Sweep old days, then keep the flush timer running for this process's lifetime. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.sweep().catch(() => {});
    this.flushTimer = setInterval(() => {
      void this.flush().catch((error) => console.error('Activity log flush failed', error));
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.started = false;
  }

  /** Buffer one entry; a repeated event id (replayed burst, restarted bridge) is ignored. */
  append(event: EmberEvent): void {
    const entry = entryFromEvent(event, this.now());
    if (!entry) return;
    if (this.recentIds.has(entry.id)) return;
    this.recentIds.add(entry.id);
    this.recentOrder.push(entry.id);
    if (this.recentOrder.length > MAX_REMEMBERED_IDS) {
      const dropped = this.recentOrder.splice(0, this.recentOrder.length - MAX_REMEMBERED_IDS);
      dropped.forEach((id) => this.recentIds.delete(id));
    }
    this.buffer.push(entry);
  }

  pendingCount(): number {
    return this.buffer.length;
  }

  /** Flush buffered entries, grouped by the local day their `at` falls in. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];
    try {
      await fs.mkdir(this.directory, { recursive: true });
      const byDay = new Map<string, ActivityEntry[]>();
      for (const entry of pending) {
        const day = dayKeyOf(entry.at);
        const list = byDay.get(day) ?? [];
        list.push(entry);
        byDay.set(day, list);
      }
      for (const [day, entries] of byDay) await this.writeDay(day, entries);
    } catch (error) {
      // Keep the un-written entries (bounded) so a transient disk failure retries later
      // instead of dropping history. Reads de-dupe by id, so a partial retry stays clean.
      this.buffer = [...pending.slice(-MAX_RETRIED_ENTRIES), ...this.buffer].slice(0, MAX_RETRIED_ENTRIES);
      throw error;
    }
  }

  /** Synchronous flush for the quit path, where no pending promise can be awaited. */
  flushSync(): void {
    if (this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];
    try {
      syncFs.mkdirSync(this.directory, { recursive: true });
      const byDay = new Map<string, ActivityEntry[]>();
      for (const entry of pending) {
        const day = dayKeyOf(entry.at);
        const list = byDay.get(day) ?? [];
        list.push(entry);
        byDay.set(day, list);
      }
      for (const [day, entries] of byDay) this.writeDaySync(day, entries);
    } catch (error) {
      this.buffer = [...pending.slice(-MAX_RETRIED_ENTRIES), ...this.buffer].slice(0, MAX_RETRIED_ENTRIES);
      throw error;
    }
  }

  /** Append what fits under the day's size cap, noting truncation once per day. */
  private async writeDay(day: string, entries: ActivityEntry[]): Promise<void> {
    const file = this.fileFor(day);
    let size = 0;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      /* a day file that doesn't exist yet starts at zero */
    }
    const lines: string[] = [];
    let truncated = false;
    for (const entry of entries) {
      const line = `${JSON.stringify(entry)}\n`;
      if (size + Buffer.byteLength(line, 'utf8') > this.maxDayBytes) {
        truncated = true;
        break;
      }
      size += Buffer.byteLength(line, 'utf8');
      lines.push(line);
    }
    if (lines.length > 0) await fs.appendFile(file, lines.join(''), { encoding: 'utf8', mode: 0o600 });
    if (truncated) await this.noteTruncation(file, day);
  }

  private writeDaySync(day: string, entries: ActivityEntry[]): void {
    const file = this.fileFor(day);
    let size = 0;
    try {
      size = syncFs.statSync(file).size;
    } catch {
      /* a day file that doesn't exist yet starts at zero */
    }
    const lines: string[] = [];
    let truncated = false;
    for (const entry of entries) {
      const line = `${JSON.stringify(entry)}\n`;
      if (size + Buffer.byteLength(line, 'utf8') > this.maxDayBytes) {
        truncated = true;
        break;
      }
      size += Buffer.byteLength(line, 'utf8');
      lines.push(line);
    }
    if (lines.length > 0) syncFs.appendFileSync(file, lines.join(''), { encoding: 'utf8', mode: 0o600 });
    if (truncated) {
      const note = `${JSON.stringify(this.truncationNote(day))}\n`;
      if (!this.truncatedDays.has(day)) syncFs.appendFileSync(file, note, { encoding: 'utf8', mode: 0o600 });
      this.truncatedDays.add(day);
    }
  }

  private async noteTruncation(file: string, day: string): Promise<void> {
    if (this.truncatedDays.has(day)) return;
    this.truncatedDays.add(day);
    const note = `${JSON.stringify(this.truncationNote(day))}\n`;
    await fs.appendFile(file, note, { encoding: 'utf8', mode: 0o600 });
  }

  private truncationNote(day: string): ActivityEntry {
    const at = this.now();
    return {
      id: `ember:activity:truncated:${day}`,
      at,
      instanceId: 'ember',
      type: 'activity.truncated',
      summary: 'activity for this day hit its size cap and stopped recording',
    };
  }

  /** Delete day files older than the retention window (local days). */
  async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch {
      return;
    }
    const cutoff = dayKeyOf(this.now() - this.retentionDays * 86_400_000);
    await Promise.all(
      names
        .map((name) => DAY_FILE.exec(name)?.[1])
        .filter((day): day is string => typeof day === 'string' && day < cutoff)
        .map((day) => fs.unlink(this.fileFor(day)).catch(() => {}))
    );
  }

  /** Local days with a file on disk, newest first. */
  async days(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch {
      return [];
    }
    return names
      .map((name) => DAY_FILE.exec(name)?.[1])
      .filter((day): day is string => typeof day === 'string')
      .sort()
      .reverse();
  }

  /** Newest-first entries for a day file; repeated ids (a retried flush) collapse. */
  private async readDay(day: string): Promise<ActivityEntry[]> {
    let contents: string;
    try {
      contents = await fs.readFile(this.fileFor(day), 'utf8');
    } catch {
      return [];
    }
    const byId = new Map<string, ActivityEntry>();
    for (const line of contents.split('\n')) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = parseActivityEntry(parsed);
      if (entry) byId.set(entry.id, entry);
    }
    return [...byId.values()];
  }

  private inRange(entry: ActivityEntry, from?: number, to?: number): boolean {
    if (from !== undefined && entry.at < from) return false;
    if (to !== undefined && entry.at > to) return false;
    return true;
  }

  /**
   * Newest-first page across day files (or one day when `query.day` is set). The cursor is
   * opaque and counts entries already served, so paging continues into older days.
   */
  async list(query: ActivityQuery = {}): Promise<ActivityPage> {
    const limit = Math.min(Math.max(Math.round(query.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
    const dayNames = query.day && DAY_KEY.test(query.day) ? [query.day] : await this.days();
    const collected: ActivityEntry[] = [];
    for (const day of dayNames) {
      const entries = (await this.readDay(day))
        .filter((entry) => this.inRange(entry, query.from, query.to))
        .sort((a, b) => b.at - a.at);
      collected.push(...entries);
    }
    return this.page(collected, parseCursor(query.cursor), limit);
  }

  /** Case-insensitive substring search over the log (summary, type, ids, detail values). */
  async search(needle: string, query: ActivityQuery = {}): Promise<ActivityPage> {
    const term = needle.trim().toLowerCase();
    if (!term) return this.list(query);
    const limit = Math.min(Math.max(Math.round(query.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
    const dayNames = query.day && DAY_KEY.test(query.day) ? [query.day] : await this.days();
    const collected: ActivityEntry[] = [];
    for (const day of dayNames) {
      const entries = (await this.readDay(day))
        .filter((entry) => this.inRange(entry, query.from, query.to))
        .filter((entry) => this.matches(entry, term))
        .sort((a, b) => b.at - a.at);
      collected.push(...entries);
    }
    return this.page(collected, parseCursor(query.cursor), limit);
  }

  private matches(entry: ActivityEntry, term: string): boolean {
    const haystack = [entry.summary, entry.type, entry.instanceId, entry.sessionId ?? '', ...Object.values(entry.detail ?? {})];
    return haystack.some((value) => value.toLowerCase().includes(term));
  }

  private page(collected: ActivityEntry[], skip: number, limit: number): ActivityPage {
    const entries = collected.slice(skip, skip + limit);
    const cursor = skip + entries.length < collected.length ? String(skip + entries.length) : undefined;
    return { entries, cursor };
  }

  /** Remove all recorded history (and anything still buffered). */
  async clear(): Promise<void> {
    this.buffer = [];
    this.recentIds.clear();
    this.recentOrder = [];
    this.truncatedDays.clear();
    const dayNames = await this.days().catch(() => [] as string[]);
    await Promise.all(dayNames.map((day) => fs.unlink(this.fileFor(day)).catch(() => {})));
  }
}
