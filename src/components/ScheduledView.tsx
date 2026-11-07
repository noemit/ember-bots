import * as React from 'react';
import { CalendarClock, CheckCircle2, CircleAlert, Loader2, Play, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { ScheduledTask } from '../api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { deriveNextRunAt, formatPlanSummary, type ScheduledRunRow } from '../lib/scheduledView';
import { modelLabel } from '../lib/modelLabel';
import type { SilentInstance } from '../lib/instanceHealth';
import type { Instance, Session } from '../types';

type Props = {
  tasks: ScheduledTask[];
  runs: ScheduledRunRow[];
  instances: Instance[];
  silentInstances: SilentInstance[];
  runningTaskKeys: Set<string>;
  onOpenSession: (session: Session) => void;
  onRunTask: (task: ScheduledTask) => void;
  onChangeTaskModel: (task: ScheduledTask) => void;
  onRetryInstances: () => void;
  retryingInstances: boolean;
};

const formatRelative = (epochMs: number): string => {
  if (!epochMs || !Number.isFinite(epochMs)) return 'Unknown time';
  const diffSec = Math.round((epochMs - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return diffSec >= 0 ? 'in a moment' : 'just now';
  const mins = Math.round(abs / 60);
  if (mins < 60) return diffSec >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diffSec >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return diffSec >= 0 ? `in ${days}d` : `${days}d ago`;
};

const formatClock = (epochMs: number): string => {
  if (!epochMs || !Number.isFinite(epochMs)) return '';
  return new Date(epochMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export default function ScheduledView({
  tasks,
  runs,
  instances,
  silentInstances,
  runningTaskKeys,
  onOpenSession,
  onRunTask,
  onChangeTaskModel,
  onRetryInstances,
  retryingInstances,
}: Props) {
  const multiInstance = instances.length > 1;
  const instanceLabels = React.useMemo(
    () => new Map(instances.map((instance) => [instance.id, instance.label])),
    [instances]
  );

  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background px-4 py-5 sm:px-8"
      data-testid="scheduled-view"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-3">
          <div>
            <h1 className="text-base font-semibold text-foreground">Scheduled</h1>
            <p className="text-xs text-muted-foreground">
              Runs across every connected host, newest first, with the plans that trigger them kept apart.
            </p>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {runs.length} {runs.length === 1 ? 'run' : 'runs'} · {tasks.length}{' '}
            {tasks.length === 1 ? 'plan' : 'plans'}
          </span>
        </header>

        {silentInstances.length > 0 ? (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/20 px-3.5 py-2 text-xs text-muted-foreground"
          >
            <span>
              {silentInstances.map((host) => host.label).join(', ')}{' '}
              {silentInstances.length === 1 ? "didn't answer" : "didn't answer"} — scheduled tasks on{' '}
              {silentInstances.length === 1 ? 'that host' : 'those hosts'} aren&apos;t shown until it is back.
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={retryingInstances}
              onClick={onRetryInstances}
              className="h-6 gap-1 px-2 text-xs"
            >
              <RefreshCw className={cn('size-3', retryingInstances && 'animate-spin')} />
              {retryingInstances ? 'Checking…' : 'Retry'}
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.35fr_1fr]">
          {/* Column 1: All runs, newest first */}
          <section aria-label="Scheduled runs" className="flex flex-col gap-2" data-testid="scheduled-runs-list">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Recent runs
              </h2>
            </div>

            {runs.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
                {tasks.length === 0
                  ? 'No scheduled runs yet. Ask an agent to schedule a recurring or one-off task, and its runs will appear here.'
                  : 'None of your scheduled plans have recorded a run in this window yet. Use Run now on a plan to trigger one immediately.'}
              </div>
            ) : (
              <div className="flex flex-col divide-y rounded-lg border bg-card">
                {runs.map((run) => {
                  const title = run.session?.title?.trim() || run.task.name;
                  return (
                    <div
                      key={run.key}
                      data-testid="scheduled-run-row"
                      data-run-status={run.status}
                      className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 text-xs hover:bg-muted/30"
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-2.5">
                        {run.status === 'running' ? (
                          <Loader2 className="mt-0.5 size-3.5 flex-none animate-spin text-highlight" aria-hidden="true" />
                        ) : run.status === 'failed' ? (
                          <CircleAlert className="mt-0.5 size-3.5 flex-none text-destructive" aria-hidden="true" />
                        ) : (
                          <CheckCircle2 className="mt-0.5 size-3.5 flex-none text-success" aria-hidden="true" />
                        )}
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <div className="flex min-w-0 items-center gap-1.5">
                            {run.unseen ? (
                              <span
                                className="size-1.5 flex-none rounded-full bg-highlight"
                                title="Unread messages"
                              />
                            ) : null}
                            {run.session ? (
                              <button
                                type="button"
                                onClick={() => onOpenSession(run.session!)}
                                className="min-w-0 truncate text-left font-medium text-foreground hover:underline"
                              >
                                {title}
                              </button>
                            ) : (
                              <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
                            )}
                            <span className="flex-none rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {run.task.name}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span>
                              {run.status === 'running'
                                ? 'Running now'
                                : run.status === 'failed'
                                  ? run.error
                                    ? `Failed: ${run.error}`
                                    : 'Failed'
                                  : 'Succeeded'}
                            </span>
                            {run.at > 0 ? (
                              <span title={formatClock(run.at)}>· {formatRelative(run.at)}</span>
                            ) : null}
                            {multiInstance && run.instanceLabel ? <span>· {run.instanceLabel}</span> : null}
                          </div>
                        </div>
                      </div>
                      {run.session ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => onOpenSession(run.session!)}
                          className="h-6 flex-none px-2 text-[11px]"
                        >
                          Open
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Column 2: Plans (triggers), kept apart from runs */}
          <section aria-label="Scheduled plans" className="flex flex-col gap-2" data-testid="scheduled-plans-list">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Plans
              </h2>
            </div>

            {tasks.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
                No scheduled plans configured yet.
              </div>
            ) : (
              <div className="flex flex-col divide-y rounded-lg border bg-card">
                {tasks.map((task) => {
                  const schedule = formatPlanSummary(task);
                  const nextRunAt = deriveNextRunAt(task);
                  const running = runningTaskKeys.has(task.key);
                  const failed = task.state.lastStatus === 'error' || Boolean(task.state.lastError);
                  const hostLabel = instanceLabels.get(task.instanceId);
                  return (
                    <div
                      key={task.key}
                      data-testid="scheduled-plan-row"
                      data-task-key={task.key}
                      className="flex flex-col gap-1.5 px-3.5 py-2.5 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <CalendarClock
                            className={cn(
                              'size-3.5 flex-none',
                              task.enabled ? 'text-muted-foreground' : 'text-muted-foreground/40'
                            )}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 truncate font-medium text-foreground">{task.name}</span>
                          {!task.enabled ? (
                            <span className="flex-none rounded-sm bg-muted px-1 text-[9.5px] leading-4 font-semibold text-muted-foreground uppercase">
                              paused
                            </span>
                          ) : null}
                          {failed ? (
                            <span
                              className="flex-none text-[10px] font-medium text-destructive"
                              title={task.state.lastError}
                            >
                              last run failed
                            </span>
                          ) : null}
                        </div>
                        <div className="flex flex-none items-center gap-1">
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            disabled={running}
                            onClick={() => onRunTask(task)}
                            aria-label={`Run ${task.name} now`}
                            title={`Run ${task.name} now`}
                            className="h-6 gap-1 px-1.5 text-[11px]"
                          >
                            {running ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                            <span>Run now</span>
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() => onChangeTaskModel(task)}
                            aria-label={`Change model for ${task.name}`}
                            title={`Change model for ${task.name}`}
                            className="size-6 p-0 text-muted-foreground hover:text-foreground"
                          >
                            <SlidersHorizontal className="size-3" />
                          </Button>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-[11px] text-muted-foreground">
                        <span>{schedule}</span>
                        {nextRunAt ? (
                          <span title={formatClock(nextRunAt)}>· next {formatRelative(nextRunAt)}</span>
                        ) : null}
                        {task.model ? <span>· {modelLabel(task.model)}</span> : null}
                        {multiInstance && hostLabel ? <span>· {hostLabel}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
