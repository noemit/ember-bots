import type { PiHostMemory, PiLeftProcess } from './piMapping';

/**
 * What a session's "still running" notice says, and how alarmed it should be.
 *
 * A process an agent left running is often deliberate (a dev server someone asked for) and sometimes
 * the reason a machine is dying (a video job, a browser, a watcher per session). The two cases are
 * the same list of names, so what separates them is **the host**, not the process: `normal` memory is
 * information a person can ignore, `low`/`critical` is the moment stopping something is the useful
 * move. That is why the tone — and the sentence — comes from the host's memory level and never from
 * the count.
 *
 * Pure on purpose: the wording and the tone are pinned by tests instead of by squinting at a live
 * session. The three states the notice renders are:
 *
 * - **calm** — programs are running, the machine is fine: a status line with a Stop next to it;
 * - **warning / critical** — the machine is short of memory: the same list, escalated, and the
 *   sentence leads with what it costs;
 * - **refused** — a stop was asked for and the process ignored it, which is the only case that
 *   offers something stronger (`force`).
 */
export type LeftRunningTone = 'calm' | 'warning' | 'critical';

export type LeftRunningRow = {
  pid: number;
  /** The command, shortened for a row: one line, no argument flood. */
  label: string;
  /** `310 MB, since 18:12` — the cost and the age, in the order a person asks them. */
  detail: string;
};

export type LeftRunningNotice = {
  tone: LeftRunningTone;
  /** The lead sentence: what is running and why it matters (or does not). */
  text: string;
  /** The primary action's label. */
  action: string;
  rows: LeftRunningRow[];
  /** Programs beyond the rows the host sent, so the list never claims to be complete when it isn't. */
  hidden: number;
};

/** `310 MB`, `1.2 GB`, `0 B`: sizes a person reads, not byte counts. */
export const leftRunningBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
};

/**
 * When the process started, as a person would say it: the clock time for today, and the day for
 * anything older (a session left running since yesterday is a different fact from one started an
 * hour ago).
 */
export const leftRunningSince = (startedAt: number | undefined, now = Date.now()): string => {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return '';
  const at = new Date(startedAt);
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `since ${time}`;
  const day = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `since ${day} ${time}`;
};

/** A command line as one short row: the program and its first arguments, not the whole invocation. */
export const leftRunningLabel = (command: string, max = 60): string => {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return 'a process with no command line';
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

export type LeftRunningInput = {
  processes: readonly PiLeftProcess[];
  /** The real total; `processes` may be only the heaviest few. */
  count: number;
  rssBytes: number;
  memory?: PiHostMemory;
  /** The host's human name (Ember's instance label), for the sentences that blame the machine. */
  hostLabel?: string;
  now?: number;
};

/**
 * The notice for a session's leftovers.
 *
 * Returns `null` when there is nothing to say, so a caller renders nothing rather than an empty
 * status region — an "0 programs running" line would be noise on every session that behaves.
 */
export const leftRunningNotice = (input: LeftRunningInput): LeftRunningNotice | null => {
  const count = Math.max(input.count, input.processes.length);
  if (count === 0) return null;
  const now = input.now ?? Date.now();
  const rows = input.processes.map((process) => ({
    pid: process.pid,
    label: leftRunningLabel(process.command),
    detail: [leftRunningBytes(process.rssBytes), leftRunningSince(process.startedAt, now)]
      .filter(Boolean)
      .join(', '),
  }));
  const hidden = Math.max(0, count - rows.length);
  const programs = `${count} ${plural(count, 'program', 'programs')}`;
  const cost = leftRunningBytes(input.rssBytes);
  const host = input.hostLabel?.trim() || 'This host';
  const action = count === 1 ? 'Stop it' : count === 2 ? 'Stop both' : `Stop all ${count}`;
  const level = input.memory?.level ?? 'normal';

  if (level === 'critical') {
    return {
      tone: 'critical',
      // Says the actor (the machine), the amount, and why acting now is worth it — a person reading
      // this is one bad allocation away from losing work in every other session too.
      text: `${host} is nearly out of memory. ${count === 1 ? 'The program' : `The ${programs}`} this session left running ${count === 1 ? 'holds' : 'hold'} ${cost} of it, and stopping ${count === 1 ? 'it' : 'them'} frees that now.`,
      action,
      rows,
      hidden,
    };
  }
  if (level === 'low') {
    return {
      tone: 'warning',
      text: `${host} is running low on memory, and ${count === 1 ? 'the program' : `the ${programs}`} this session left running ${count === 1 ? 'holds' : 'hold'} ${cost} of it. Stopping ${count === 1 ? 'it' : 'them'} would give that back.`,
      action,
      rows,
      hidden,
    };
  }
  return {
    tone: 'calm',
    // Calm is not vague: it says what keeps happening and why, so the Stop is a choice rather than
    // a demand. Nothing here claims the process is a problem.
    text: `This bot has ${programs} running. Stop ${count === 1 ? 'it' : 'them'} when you no longer need them.`,
    action,
    rows,
    hidden,
  };
};

/**
 * The question a refused stop asks: the process took SIGTERM and is still there, so the only thing
 * left is force — which is destructive and therefore named as such, with the cost spelled out.
 */
export const forceStopQuestion = (labels: readonly string[]): string => {
  const named = labels.filter(Boolean);
  if (named.length <= 1) {
    const what = named[0] ?? 'The program';
    return `${what} didn't stop when asked. Force stop ends it at once, and anything it hasn't saved is lost.`;
  }
  return `${named.length} programs didn't stop when asked. Force stop ends them at once, and anything they haven't saved is lost.`;
};

/**
 * The failure copy when the stop request itself did not land. It names the host, says that nothing
 * was stopped (which is the fact a person needs to know), and gives the command that works today.
 */
export const stopFailedNotice = (hostLabel: string | undefined, pids: readonly number[]): string => {
  const host = hostLabel?.trim() || 'The host';
  const command = pids.length > 0 ? `kill ${pids.join(' ')}` : 'kill <pid>';
  return `${host} didn't answer the stop request, so nothing was stopped. Try again, or run ${command} in a terminal on that machine.`;
};
