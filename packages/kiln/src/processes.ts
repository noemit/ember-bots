import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { freemem, totalmem } from "node:os";

/**
 * What a session's commands leave running.
 *
 * An agent runs `vite`, a dev server, a browser, or `(nohup worker &)` and the process outlives the
 * turn. Those processes are the host's, not the session's, as far as the OS is concerned: on Linux
 * they sit in Hearth's own systemd unit, so systemd-oomd charges their memory to Hearth and the next
 * Hearth restart kills them (measured on Heliograph 2026-11-04: 243 processes killed at 16:44, and
 * ~3.7 GB of the unit's 4.3 GB was not Hearth). On Windows nothing kills them at all, and they
 * accumulate across restarts.
 *
 * So a command's children carry a **tag**: `HEARTH_CONVERSATION=<id>` in the environment Hearth
 * builds for the session's shell, inherited by everything it starts — `nohup`, `setsid` and `&`
 * included. Reading that tag back is what makes a leftover *attributable* to the session that
 * caused it, which is what lets a client offer to stop it and refuse to stop someone else's.
 *
 * **What counts as left behind.** Not every tagged process: a command that is still running is a
 * live command, not a leftover. A process is a leftover when its ancestors no longer reach this
 * Hearth process — reparented to init (-ish) because the shell it belonged to exited. That also
 * means a process left by a *previous* Hearth run is still attributed correctly after a restart,
 * which is the case that matters: on Windows nothing else ever cleans up.
 *
 * On Linux the tag is read from `/proc/<pid>/environ`, one pass per scan. Elsewhere the environment
 * of another process is not readable without native code, so the process table is polled **while a
 * command runs** and remembered in a ledger (see `CommandWatch`); a process that outlives the command
 * it was seen during is a leftover. That path is conservative — it records nothing while two commands
 * of the same host are in flight, because attributing a child to the wrong session would let one
 * session stop another's process.
 */

/** The environment variable that carries a conversation id into everything a session starts. */
export const TAG_ENV = "HEARTH_CONVERSATION";

/** One process Hearth attributes to a conversation. */
export type LeftProcess = {
  pid: number;
  /** One line, shortened for a log line or a notice; never the whole multi-line command. */
  command: string;
  rssBytes: number;
  /** When the process started, epoch ms (an estimate on Linux, see `CLOCK_TICKS`). */
  startedAt: number;
};

export type MemoryLevel = "normal" | "low" | "critical";

export type HostMemory = {
  totalBytes: number;
  availableBytes: number;
  level: MemoryLevel;
};

/** Shorten a command for display: one line, no argument flood, never empty. */
export const briefCommand = (raw: string, max = 160): string => {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "(no command line)";
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};

/**
 * `available / total` says how much room there is, and the two names matter: `low` is "this host is
 * short of memory, and clearing what a session left behind would help", `critical` is "the OOM
 * killer is about to choose a victim". The thresholds are ratios so they mean the same on a 16 GB PC
 * and a 64 GB one, and they are deliberately above the point of failure: a notice that only appears
 * once the host is already thrashing arrives too late to act on.
 */
export const pressureOf = (memory: { totalBytes: number; availableBytes: number }): MemoryLevel => {
  const total = memory.totalBytes;
  const ratio = total > 0 ? memory.availableBytes / total : 1;
  if (ratio < 0.05) return "critical";
  if (ratio < 0.12) return "low";
  return "normal";
};

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** The conversation tag in a `/proc/<pid>/environ` body, or undefined when there is none. */
export const tagOf = (environ: string): number | undefined => {
  const prefix = `${TAG_ENV}=`;
  for (const entry of environ.split("\0")) {
    if (!entry.startsWith(prefix)) continue;
    const value = Number(entry.slice(prefix.length));
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  return undefined;
};

/**
 * The fields of `/proc/<pid>/stat` this module needs.
 *
 * Field 2 (`comm`) is wrapped in parentheses and may itself contain spaces and parentheses, so the
 * fields are counted from the **last** `)` — a `split(" ")` on the whole line misnumbers every
 * process whose name contains a space (`npm exec @playwright/mcp`).
 */
export const parseStat = (stat: string): { ppid: number; startTicks: number } | undefined => {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  // From field 3 (state) onward: index 0 is state, so ppid (field 4) is 1 and starttime (22) is 19.
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const startTicks = Number(fields[19]);
  if (!Number.isSafeInteger(ppid) || !Number.isFinite(startTicks)) return undefined;
  return { ppid, startTicks };
};

/** `VmRSS:  123456 kB` from `/proc/<pid>/status`. */
export const parseRss = (status: string): number => {
  const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
  return match?.[1] === undefined ? 0 : Number(match[1]) * 1024;
};

const parseCommand = (cmdline: string | undefined, comm: string | undefined): string => {
  const command = (cmdline ?? "").split("\0").filter(Boolean).join(" ").trim();
  return briefCommand(command.length > 0 ? command : `[${comm ?? "process"}]`);
};

/**
 * Linux reports a process's start as clock ticks since boot; converting it to an epoch needs the
 * tick rate, which `sysconf(_SC_CLK_TCK)` would give. It is 100 on every Linux this runs on (x86_64,
 * arm64, all the usual container images); a wrong value only shifts the "since" a notice shows.
 */
const CLOCK_TICKS = 100;

const bootTimeMs = (): number => {
  const uptime = readText("/proc/uptime")?.split(/\s+/)[0];
  const seconds = Number(uptime);
  return Number.isFinite(seconds) ? Date.now() - seconds * 1000 : Date.now();
};

type TaggedRow = LeftProcess & { conversationId: number };

type ProcSnapshot = {
  /** Every process carrying a tag, across all conversations. */
  tagged: TaggedRow[];
  /** Child → parent, for every process on the host that could be read. */
  parents: Map<number, number>;
};

/**
 * One pass over the process table: parent links for everyone (needed to walk an ancestor chain),
 * and the tag, command and memory for the processes that carry one.
 */
export const snapshotLinux = (options: { procRoot?: string; now?: number } = {}): ProcSnapshot => {
  const root = options.procRoot ?? "/proc";
  const parents = new Map<number, number>();
  const tagged: TaggedRow[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { tagged, parents };
  }
  const startedBase = bootTimeMs();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const dir = join(root, entry);
    const stat = readText(join(dir, "stat"));
    if (stat === undefined) continue;
    const parsed = parseStat(stat);
    if (parsed === undefined) continue;
    parents.set(pid, parsed.ppid);
    const environ = readText(join(dir, "environ"));
    if (environ === undefined) continue;
    const conversationId = tagOf(environ);
    if (conversationId === undefined) continue;
    tagged.push({
      conversationId,
      pid,
      command: parseCommand(readText(join(dir, "cmdline")), stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))),
      rssBytes: parseRss(readText(join(dir, "status")) ?? ""),
      startedAt: startedBase + (parsed.startTicks / CLOCK_TICKS) * 1000,
    });
  }
  return { tagged, parents };
};

/**
 * Tagged processes that no longer belong to a live command, grouped by conversation.
 *
 * `selfPid` is this Hearth process: anything whose ancestor chain still reaches it is a command in
 * flight (or something Hearth itself started), not something left behind. An orphan's chain ends at
 * init, so it is counted — including one left by a previous Hearth run, which is the case no other
 * mechanism catches on Windows.
 */
export const leftoversFrom = (snapshot: ProcSnapshot, selfPid: number): Map<number, LeftProcess[]> => {
  const attached = (pid: number): boolean => {
    let current = snapshot.parents.get(pid);
    for (let guard = 0; current !== undefined && guard < 128; guard += 1) {
      if (current === selfPid) return true;
      if (current <= 1) return false;
      current = snapshot.parents.get(current);
    }
    return false;
  };
  const grouped = new Map<number, LeftProcess[]>();
  for (const row of snapshot.tagged) {
    if (row.pid === selfPid || attached(row.pid)) continue;
    const { conversationId, ...process } = row;
    const list = grouped.get(conversationId);
    if (list === undefined) grouped.set(conversationId, [process]);
    else list.push(process);
  }
  for (const list of grouped.values()) list.sort((a, b) => b.rssBytes - a.rssBytes);
  return grouped;
};

// ---- Platforms without /proc --------------------------------------------------------------

/**
 * The ledger: processes seen running under a session's command on a platform whose environment is
 * not readable (`CommandWatch`), still within the window a command was in flight.
 */
const ledger = new Map<number, TaggedRow>();

/** Forget ledger rows that a refresh found gone; keeps the map from growing with dead pids. */
const pruneLedger = (alive: ReadonlySet<number>, now: number): void => {
  for (const [pid, row] of ledger) {
    // A pid that is gone, or one no longer in the table, cannot be offered for stopping. Rows are
    // also aged out so a ledger that is never refreshed (a host with no commands) does not grow.
    if (!alive.has(pid) || now - row.startedAt > 7 * 24 * 60 * 60 * 1000) ledger.delete(pid);
  }
};

export type ProcessRow = {
  pid: number;
  ppid: number;
  command: string;
  rssBytes: number;
  /** Epoch ms, or 0 when the platform did not report one. */
  startedAt: number;
};

/**
 * Every process on a Windows host, through CIM — one PowerShell call, cached by the caller.
 * `CreationDate` is what makes a pid trustworthy across reuse: a recorded `(pid, startedAt)` pair
 * that is still alive is still *that* process, and nothing else.
 */
export const listWindowsProcesses = (options: { run?: (script: string) => string } = {}): ProcessRow[] => {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine,WorkingSetSize | ConvertTo-Json -Compress -Depth 3";
  const run =
    options.run ??
    ((command: string) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }));
  let raw: string;
  try {
    raw = run(script);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ProcessRow[] = [];
  for (const record of records) {
    if (typeof record !== "object" || record === null) continue;
    const value = record as Record<string, unknown>;
    const pid = Number(value.ProcessId);
    if (!Number.isSafeInteger(pid)) continue;
    const created = typeof value.CreationDate === "string" ? windowsTimeToMs(value.CreationDate) : 0;
    rows.push({
      pid,
      ppid: Number(value.ParentProcessId) || 0,
      command: briefCommand(String(value.CommandLine ?? "")),
      rssBytes: Number(value.WorkingSetSize) || 0,
      startedAt: created,
    });
  }
  return rows;
};

/**
 * Every process on a macOS host, via `ps` — one call, cached by the caller.
 */
export const listPosixProcesses = (options: { run?: () => string; now?: () => number } = {}): ProcessRow[] => {
  const now = options.now ?? Date.now;
  const run =
    options.run ??
    (() =>
      // `etime` is elapsed time, formatted `[[dd-]hh:]mm:ss`. It is portable across BSD `ps` (macOS)
      // and procps (Linux), which `lstart` is not, and it is what makes `startedAt` meaningful here:
      // without it every row carried 0, so a leftover could not be aged, and the pid-reuse guard
      // (`|current.startedAt - recorded| > 2s`) never engaged on this platform at all.
      execFileSync("ps", ["-axo", "pid=,ppid=,rss=,etime=,command="], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
      }));
  let raw: string;
  try {
    raw = run();
  } catch {
    return [];
  }
  const rows: ProcessRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([0-9:-]+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKb = Number(match[3]);
    const elapsedMs = parseElapsed(match[4] ?? "");
    const command = briefCommand(match[5] ?? "");
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      ppid: Number.isSafeInteger(ppid) ? ppid : 0,
      command,
      rssBytes: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0,
      // Approximate by design: `etime` is whole seconds, which is why the reuse guard allows 2s.
      startedAt: elapsedMs === null ? 0 : now() - elapsedMs,
    });
  }
  return rows;
};

export const listNonLinuxProcesses = (): ProcessRow[] =>
  process.platform === "win32" ? listWindowsProcesses() : listPosixProcesses();
/**
 * `ps` elapsed time (`[[dd-]hh:]mm:ss`) to milliseconds, or null when it does not parse.
 *
 * Null rather than 0 so a future `ps` that formats this differently degrades to "unknown age"
 * instead of claiming every process started at the epoch.
 */
export const parseElapsed = (raw: string): number | null => {
  const value = raw.trim();
  if (!value) return null;
  const days = /^(\d+)-(\d+):(\d+):(\d+)$/.exec(value);
  const hours = /^(\d+):(\d+):(\d+)$/.exec(value);
  const minutes = /^(\d+):(\d+)$/.exec(value);
  const [d, h, m, s] =
    days !== null
      ? [Number(days[1]), Number(days[2]), Number(days[3]), Number(days[4])]
      : hours !== null
        ? [0, Number(hours[1]), Number(hours[2]), Number(hours[3])]
        : minutes !== null
          ? [0, 0, Number(minutes[1]), Number(minutes[2])]
          : [null, null, null, null];
  if (d === null || h === null || m === null || s === null) return null;
  if ([d, h, m, s].some((part) => !Number.isFinite(part))) return null;
  return ((d * 24 + h) * 60 * 60 + m * 60 + s) * 1000;
};

/** `/Date(1712345678901)/` (WMI) or `2026-11-04T15:44:43Z` (CIM JSON) to epoch ms. */
export const windowsTimeToMs = (raw: string): number => {
  const wmi = /\/Date\((\d+)\)\//.exec(raw);
  if (wmi?.[1] !== undefined) return Number(wmi[1]);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Record what a command's shell left behind on platforms whose process environment is unreadable.
 *
 * **Polling cannot do this job**, and two attempts at making it work shipped before anyone measured
 * why. On macOS a `ps -axo` pass takes ~70ms, and `sleep 60 & echo started` finishes in ~3ms — so
 * the only polls that can run are the one *before* the shell spawns (no child yet) and the one
 * *after* it exits (the child has been reparented to launchd, so it is no longer a descendant).
 * Shortening the interval does not help: there is no moment in between at which a poll could land.
 * Measured: 250ms, 50ms and 10ms intervals all record nothing; only a 1ms interval "worked", and
 * only because it delayed the spawn by a whole `ps` pass.
 *
 * So the shell reports for itself. The bash wrapper appends a line to a per-command file listing
 * its own children (`$!` and `jobs -p`) once the command has run; this reads that file and keeps
 * whichever of those pids are still alive and no longer ours. It is exact, it costs nothing, and it
 * needs no window — which is the property polling was pretending to have.
 *
 * The process table is still consulted, but only to answer two cheap questions afterwards: is this
 * pid still alive, and how much memory does it hold. `ps` liveness is also what makes a recycled pid
 * safe: a `(pid, startedAt)` pair that is still alive is still *that* process.
 */
export class CommandWatch {
  readonly #conversationId: number;
  readonly #selfPid: number;
  readonly #list: () => ProcessRow[];
  readonly #reportPath: string | undefined;
  #recorded = 0;

  constructor(options: {
    conversationId: number;
    selfPid?: number;
    /** Accepted for compatibility only: there is nothing to poll, so nothing reads it. */
    intervalMs?: number;
    list: () => ProcessRow[];
    /** The file the shell appended its child pids to (see `commandEnv`). */
    reportPath?: string;
  }) {
    this.#conversationId = options.conversationId;
    this.#selfPid = options.selfPid ?? process.pid;
    this.#list = options.list;
    this.#reportPath = options.reportPath;
  }

  /** How many processes this watch attributed. `0` is the honest "nothing was left running". */
  get recorded(): number {
    return this.#recorded;
  }

  /**
   * A handle, not a timer: nothing is observed while the command runs, because there is nothing a
   * poll could observe in a 3ms command. The work happens in the returned function, after it ends.
   */
  start(): () => void {
    this.#recorded = 0;
    return () => this.#finish();
  }

  #finish(): void {
    const path = this.#reportPath;
    if (path === undefined) return;
    const pids = readReportedPids(path);
    if (pids.length === 0) return;
    const alive = new Map(this.#list().map((row) => [row.pid, row]));
    const now = Date.now();
    for (const pid of pids) {
      // Gone since the command ended: it did not outlive anything, so there is nothing to report.
      const row = alive.get(pid);
      if (row === undefined || row.pid === this.#selfPid) continue;
      // Still a direct child of Hearth means the command has not really exited; not a leftover.
      if (row.ppid === this.#selfPid) continue;
      ledger.set(row.pid, {
        conversationId: this.#conversationId,
        pid: row.pid,
        command: row.command,
        rssBytes: row.rssBytes,
        startedAt: row.startedAt || now,
      });
      this.#recorded += 1;
    }
    pruneLedger(new Set(alive.keys()), now);
    if (this.#recorded > 0) {
      console.log(`[hearth]  process(es) outlived a command in conversation `);
    }
  }
}

/**
 * Where a command's shell writes the pids it started.
 *
 * A file rather than a pipe because the shell may write before anything is reading, and because the
 * reader must be able to look *after* the shell is gone.
 */
export const leftoverReportPath = (home: string, conversationId: number): string =>
  // Deterministic and derived from the home and the conversation alone: the shell learns it through
  // `HEARTH_LEFTOVERS` in its own environment, while the reader (`leftovers.ts`) runs in Hearth's
  // process and cannot see that environment. One function so the two cannot name different files.
  join(home, "leftovers", String(conversationId) + "-command.pids");

/** Delete a report file, ignoring a file that is already gone. */
export const removeFileBestEffort = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    // A leftover report that cannot be removed is noise, not a failure: the sweep below collects it.
  }
};

/** The pids a command's shell reported, ignoring anything that is not a positive integer. */
export const readReportedPids = (path: string): number[] => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const seen = new Set<number>();
  for (const line of raw.split("\n")) {
    const pid = Number(line.trim());
    if (Number.isSafeInteger(pid) && pid > 1) seen.add(pid);
  }
  return [...seen];
};

// ---- The host's view ---------------------------------------------------------------------

export type ProcessScan = {
  /** Leftover processes per conversation. */
  byConversation: Map<number, LeftProcess[]>;
  /** Every leftover, whatever its conversation (for a host-wide total). */
  all: LeftProcess[];
};

export type ScanOptions = {
  /** Test seam: a fake `/proc`. */
  procRoot?: string;
  /** Which platform's reader to use; defaults to the running one. Tests drive both on one machine. */
  platform?: NodeJS.Platform;
  selfPid?: number;
  now?: number;
  /** Windows process table; tests inject a fake, production defaults to `listWindowsProcesses`. */
  list?: () => ProcessRow[];
  /** Ignore the 1s cache. */
  fresh?: boolean;
};

let cached: { at: number; scan: ProcessScan } | undefined;
const SCAN_TTL_MS = 1_000;

/**
 * The host's leftovers, grouped by conversation. Cached for a second: the conversations list is
 * polled by every client, and one `/proc` pass per poll would be paid per conversation-page request
 * rather than per second.
 */
export const scanLeftovers = (options: ScanOptions = {}): ProcessScan => {
  const now = options.now ?? Date.now();
  if (!options.fresh && cached !== undefined && now - cached.at < SCAN_TTL_MS) return cached.scan;
  let byConversation: Map<number, LeftProcess[]>;
  if ((options.platform ?? process.platform) === "linux") {
    byConversation = leftoversFrom(snapshotLinux({ procRoot: options.procRoot, now }), options.selfPid ?? process.pid);
  } else {
    const rows = (options.list ?? listNonLinuxProcesses)();
    const alive = new Set(rows.map((row) => row.pid));
    pruneLedger(alive, now);
    byConversation = new Map();
    for (const row of rows) {
      const entry = ledger.get(row.pid);
      if (entry === undefined) continue;
      if (entry.startedAt > 0 && row.startedAt > 0 && Math.abs(row.startedAt - entry.startedAt) > 2_000) continue;
      const process: LeftProcess = {
        pid: row.pid,
        command: row.command || entry.command,
        rssBytes: row.rssBytes || entry.rssBytes,
        startedAt: entry.startedAt || row.startedAt,
      };
      const list = byConversation.get(entry.conversationId);
      if (list === undefined) byConversation.set(entry.conversationId, [process]);
      else list.push(process);
    }
    for (const list of byConversation.values()) list.sort((a, b) => b.rssBytes - a.rssBytes);
  }
  const all = [...byConversation.values()].flat().sort((a, b) => b.rssBytes - a.rssBytes);
  const scan = { byConversation, all };
  cached = { at: now, scan };
  return scan;
};

/**
 * Test seam: forget the cached scan.
 *
 * It used to clear the ledger too, which made one shipped test impossible to pass: the test runs
 * commands in `beforeAll`, then calls this before asserting, so every recording a working watch had
 * made was wiped and the assertion saw zero. "The scan cache" and "what has been observed" are
 * different state, and only the first is disposable between cases.
 */
export const resetProcessCache = (): void => {
  cached = undefined;
};

/** Test seam for the ledger alone, for a case that needs a clean slate for observations. */
export const resetLeftoverLedger = (): void => {
  ledger.clear();
};

/** The host's memory, with the level a client renders. */
export const hostMemory = (options: { read?: () => { totalBytes: number; availableBytes: number } } = {}): HostMemory => {
  const read = options.read ?? (() => {
    const meminfo = readText("/proc/meminfo");
    if (meminfo !== undefined) {
      const total = /MemTotal:\s+(\d+)\s+kB/.exec(meminfo)?.[1];
      const available = /MemAvailable:\s+(\d+)\s+kB/.exec(meminfo)?.[1];
      if (total !== undefined && available !== undefined) {
        return { totalBytes: Number(total) * 1024, availableBytes: Number(available) * 1024 };
      }
    }
    return { totalBytes: totalmem(), availableBytes: freemem() };
  });
  const memory = read();
  return { ...memory, level: pressureOf(memory) };
};

/**
 * The sentence an agent reads when its command leaves something behind.
 *
 * Written as a result line rather than a prompt rule: an agent acts on what a tool told it far more
 * reliably than on what a system prompt advised. It names the processes, the cost, what the human
 * sees, and the exact command that ends them — a dead end ("please clean up") is not a next step.
 */
export const leftoverNote = (processes: readonly LeftProcess[]): string => {
  const listed = processes
    .slice(0, 5)
    .map((process) => `\`${process.command}\` (pid ${process.pid}, ${megabytes(process.rssBytes)})`)
    .join(", ");
  const more = processes.length > 5 ? `, and ${processes.length - 5} more` : "";
  const kill = processes.map((process) => process.pid).join(" ");
  return (
    `Left running by this command: ${listed}${more}. ` +
    "It keeps running after your turn, and the user sees it on this session with a Stop button. " +
    `Stop what you no longer need: \`kill ${kill}\`.`
  );
};

/** `310 MB`, `1.2 GB`, `0 B` — the size a person reads, not a byte count. */
export const megabytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
};
