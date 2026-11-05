import * as React from 'react';
import { CircleAlert, Clock, OctagonAlert, Plus, SquareTerminal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  forceStopQuestion,
  leftRunningLabel,
  leftRunningNotice,
  stopFailedNotice,
  type LeftRunningTone,
} from '../lib/leftRunning';
import {
  deadlineTitle,
  expiryLabel,
  processExpiry,
  PROCESS_EXTENSION_MS,
} from '../lib/processExpiry';
import type { HostMemory, LeftProcess, ProcessStopResult, SessionProcesses } from '../types';

/** What the column's stop handler answers: the host's outcomes, or a failure to reach it at all. */
export type StopProcessesResult =
  | { ok: true; results: ProcessStopResult[]; processes: SessionProcesses | undefined; memory?: HostMemory }
  | { ok: false };

type Props = {
  processes: SessionProcesses;
  memory?: HostMemory;
  /** The host's human name, for the sentences that blame the machine. */
  hostLabel?: string;
  /** Stop these pids on the host. Resolves `{ ok: false }` when the request did not land. */
  onStop: (pids: number[], options: { force?: boolean }) => Promise<StopProcessesResult>;
  /**
   * Total extra time already granted to this session's programs, in ms.
   *
   * Held by the caller rather than here, because the reaper owns the same number: a deadline this
   * component extended and the timer did not would be a promise the app breaks ten minutes later.
   */
  extensionMs?: number;
  /** Add the clock button's extension. Omitted where nothing can extend (the reading view). */
  onExtend?: () => void;
  /** Now, so a countdown can tick without every row re-reading the clock. */
  now?: number;
};

const TONE_CLASSES: Record<LeftRunningTone, string> = {
  // Calm is a status line, not a warning: the same muted surface as every other quiet row, so a
  // dev server someone asked for does not read as a fault.
  calm: 'text-muted-foreground',
  warning: 'text-foreground',
  critical: 'text-foreground',
};

const TONE_ICON = {
  calm: SquareTerminal,
  warning: CircleAlert,
  critical: OctagonAlert,
} as const;

/**
 * What this agent's commands left running, with the control that ends it — as one tray of the
 * composer shelf, beside the queue and the notes.
 *
 * Three states, and they are the ones `lib/leftRunning` decides:
 *
 * - **calm** (host memory normal): a quiet line listing the programs, and a Stop.
 * - **warning / critical** (host short of memory): the same list, escalated — the lead sentence names
 *   the machine and what these programs hold of it, because that is the part that matters then.
 * - **refused**: a stop was asked for and the process ignored it, so the only remaining step is
 *   force. It is destructive, so it asks first and says what it costs.
 *
 * Every row also carries the deadline Ember will stop it at (`lib/processExpiry`): a countdown, not
 * a start time, because the number that matters is how long there is to decide. The clock beside it
 * buys another ten minutes; the sum lives with the reaper so the two cannot disagree.
 *
 * A failed request says nothing was stopped and gives the command that works from a terminal: the
 * one thing worse than a process that will not stop is a button that silently did nothing.
 */
export default function SessionProcessesNotice({
  processes,
  memory,
  hostLabel,
  onStop,
  extensionMs = 0,
  onExtend,
  now = Date.now(),
}: Props) {
  const [busy, setBusy] = React.useState<number[] | null>(null);
  const [refused, setRefused] = React.useState<ProcessStopResult[]>([]);
  const [problem, setProblem] = React.useState<string | null>(null);

  const notice = leftRunningNotice({
    processes: processes.items,
    count: processes.count,
    rssBytes: processes.rssBytes,
    ...(memory ? { memory } : {}),
    ...(hostLabel ? { hostLabel } : {}),
    now,
  });

  // A refusal only matters while the process is still listed: one the host no longer attributes to
  // this session is not this session's to force, so it drops out of the question instead of asking
  // about something that is already gone.
  const livePids = new Set(processes.items.map((process) => process.pid));
  const refusedNow = refused.filter((entry) => livePids.has(entry.pid));

  if (!notice) return null;

  const stop = async (pids: number[], options: { force?: boolean } = {}) => {
    if (pids.length === 0) return;
    setBusy(pids);
    setProblem(null);
    const answer = await onStop(pids, options);
    setBusy(null);
    if (!answer.ok) {
      setProblem(stopFailedNotice(hostLabel, pids));
      return;
    }
    // A refusal is only worth asking about while the process is still in the list: a pid the host
    // no longer attributes to this session is not this session's to force.
    const stillListed = new Set((answer.processes?.items ?? []).map((process) => process.pid));
    const refusedByHost = answer.results.filter((entry) => entry.outcome === 'refused' && stillListed.has(entry.pid));
    setRefused(refusedByHost);
  };

  const Icon = TONE_ICON[notice.tone];
  const stopping = busy !== null;
  const forceLabels = refusedNow.map(
    (entry) => entry.command ?? processes.items.find((process) => process.pid === entry.pid)?.command ?? `pid ${entry.pid}`
  );
  // The soonest deadline in the session is the one that acts, and the one the tray's own header
  // count should be read against.
  const expiries = new Map(
    processes.items.map((process) => [process.pid, processExpiry(process.startedAt, now, extensionMs)])
  );
  const soonest = [...expiries.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];

  return (
    <section
      data-session-processes={notice.tone}
      role={notice.tone === 'calm' ? 'status' : 'alert'}
      aria-live={notice.tone === 'calm' ? 'polite' : 'assertive'}
      className={cn('flex min-w-0 flex-col gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-xs', TONE_CLASSES[notice.tone])}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <Icon className="mt-px size-3.5 flex-none" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-[11.5px] leading-snug">{notice.text}</p>
        {soonest ? (
          <span
            className={cn(
              'flex flex-none items-center gap-1 tabular-nums',
              soonest.expired ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            <Clock className="size-3" aria-hidden="true" />
            {expiryLabel(soonest.remainingMs)}
            {onExtend ? (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onExtend}
                aria-label="Keep these 10 more minutes"
                title="Keep these 10 more minutes"
                className="-my-1"
              >
                <Plus aria-hidden="true" />
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
      <ul className="flex min-w-0 flex-col gap-1 pl-5">
        {notice.rows.map((row) => {
          const expiry = expiries.get(row.pid);
          return (
            <li key={row.pid} className="flex min-w-0 items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90" title={row.label}>
                {row.label}
              </code>
              {expiry ? (
                <span
                  className={cn('flex-none text-[11px] tabular-nums', expiry.expired ? 'text-destructive' : 'text-muted-foreground')}
                  title={deadlineTitle(expiry.expiresAt, now)}
                >
                  {expiryLabel(expiry.remainingMs)}
                </span>
              ) : null}
              {notice.rows.length > 1 ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Stop ${row.label}`}
                  title={`Stop ${row.label}`}
                  disabled={stopping}
                  onClick={() => void stop([row.pid])}
                >
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          );
        })}
        {notice.hidden > 0 ? (
          <li className="text-[11px] text-muted-foreground">
            and {notice.hidden} more, weighing {notice.hidden === 1 ? 'it' : 'them'} into the total
          </li>
        ) : null}
      </ul>

      {refusedNow.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1.5 rounded border border-destructive/40 bg-destructive/5 px-2 py-1.5">
          <p className="text-[11.5px] leading-snug">{forceStopQuestion(forceLabels)}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="destructive"
              size="xs"
              disabled={stopping}
              onClick={() => void stop(refusedNow.map((entry) => entry.pid), { force: true })}
            >
              Force stop
            </Button>
            <Button variant="ghost" size="xs" disabled={stopping} onClick={() => setRefused([])}>
              Keep {refusedNow.length === 1 ? 'it' : 'them'} running
            </Button>
          </div>
        </div>
      ) : null}

      {problem ? (
        <p role="alert" className="text-[11.5px] leading-snug text-destructive">
          {problem}
        </p>
      ) : null}

      {refusedNow.length === 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pl-5">
          <Button
            variant="outline"
            size="xs"
            disabled={stopping}
            onClick={() => void stop(processes.items.map((process) => process.pid))}
          >
            {stopping ? 'Stopping…' : notice.action}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** The tab's own label, for the shelf: "Programs 2". */
export const processesSectionLabel = 'Processes';

/**
 * True when the tray has something that should catch the eye without opening it: a program past its
 * deadline, or one the host is short of memory for.
 */
export const processesNeedAttention = (
  processes: SessionProcesses | undefined,
  memory: HostMemory | undefined,
  extensionMs = 0,
  now = Date.now()
): boolean => {
  if (!processes || processes.count === 0) return false;
  if ((memory?.level ?? 'normal') !== 'normal') return true;
  return processes.items.some((process: LeftProcess) => processExpiry(process.startedAt, now, extensionMs).expired);
};

export { PROCESS_EXTENSION_MS, leftRunningLabel };
