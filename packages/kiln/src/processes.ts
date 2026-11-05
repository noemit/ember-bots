import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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
export const listPosixProcesses = (options: { run?: () => string } = {}): ProcessRow[] => {
  const run =
    options.run ??
    (() =>
      execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
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
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKb = Number(match[3]);
    const command = briefCommand(match[4] ?? "");
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      ppid: Number.isSafeInteger(ppid) ? ppid : 0,
      command,
      rssBytes: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0,
      startedAt: 0,
    });
  }
  return rows;
};

export const listNonLinuxProcesses = (): ProcessRow[] =>
  process.platform === "win32" ? listWindowsProcesses() : listPosixProcesses();
/** `/Date(1712345678901)/` (WMI) or `2026-11-04T15:44:43Z` (CIM JSON) to epoch ms. */
export const windowsTimeToMs = (raw: string): number => {
  const wmi = /\/Date\((\d+)\)\//.exec(raw);
  if (wmi?.[1] !== undefined) return Number(wmi[1]);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Record the descendants of this Hearth process seen while a command runs, so that whatever
 * outlives the command can still be attributed to the session afterwards.
 *
 * `acquire` is called by the bash wrapper around each command; it polls the process table and keeps
 * the processes whose ancestor chain reaches `selfPid`. **Only one command may be watched at a
 * time.** With two in flight the same child could belong to either, so nothing is recorded — a
 * missed leftover is a smaller problem than offering to stop another session's process.
 */
export class CommandWatch {
  readonly #conversationId: number;
  readonly #selfPid: number;
  readonly #intervalMs: number;
  readonly #list: () => ProcessRow[];
  #timer: ReturnType<typeof setInterval> | undefined;
  #seen = new Map<number, ProcessRow>();
  #stopped = false;

  constructor(options: {
    conversationId: number;
    selfPid?: number;
    intervalMs?: number;
    list: () => ProcessRow[];
  }) {
    this.#conversationId = options.conversationId;
    this.#selfPid = options.selfPid ?? process.pid;
    this.#intervalMs = options.intervalMs ?? 1_500;
    this.#list = options.list;
  }

  #poll(): void {
    const rows = this.#list();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const attached = (pid: number): boolean => {
      let current = byPid.get(pid)?.ppid;
      for (let guard = 0; current !== undefined && guard < 128; guard += 1) {
        if (current === this.#selfPid) return true;
        if (current <= 1) return false;
        current = byPid.get(current)?.ppid;
      }
      return false;
    };
    for (const row of rows) {
      if (row.pid === this.#selfPid || !attached(row.pid)) continue;
      this.#seen.set(row.pid, row);
    }
  }

  /** Start polling; returns the function that ends the watch and records what survived. */
  start(): () => void {
    this.#poll();
    this.#timer = setInterval(() => this.#poll(), this.#intervalMs);
    this.#timer.unref?.();
    return () => this.#stop();
  }

  #stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    const now = Date.now();
    const alive = this.#list();
    const byPid = new Map(alive.map((row) => [row.pid, row]));
    let recorded = 0;
    for (const row of this.#seen.values()) {
      const current = byPid.get(row.pid);
      if (current === undefined) continue;
      // Creation time is the identity: a recycled pid is a different process, not this one.
      if (row.startedAt > 0 && current.startedAt > 0 && Math.abs(current.startedAt - row.startedAt) > 2_000) continue;
      ledger.set(row.pid, {
        conversationId: this.#conversationId,
        pid: row.pid,
        command: current.command || row.command,
        rssBytes: current.rssBytes,
        startedAt: row.startedAt || current.startedAt || now,
      });
      recorded += 1;
    }
    pruneLedger(new Set(alive.map((row) => row.pid)), now);
    if (recorded > 0) {
      console.log(`[hearth] ${recorded} process(es) outlived a command in conversation ${this.#conversationId}`);
    }
  }
}

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

/** Test seam: forget the cached scan and the ledger between cases. */
export const resetProcessCache = (): void => {
  cached = undefined;
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
