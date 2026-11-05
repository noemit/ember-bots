import * as React from 'react';
import { History, Loader2 } from 'lucide-react';
import Blob from '../blob/Blob';
import { projectForSession } from '../blob/seed';
import { activityEmptyCopy } from '../lib/instanceHealth';
import {
  activityDayGroups,
  entryLine,
  resolveActivityTarget,
  sessionIndex,
  type ActivityRow,
} from '@/lib/activityView';
import { sessionKey } from '../types';
import type {
  ActivityEntry,
  AvatarIdentity,
  BlobStyle,
  Instance,
  Project,
  Session,
} from '../types';

type Props = {
  entries: ActivityEntry[];
  loading: boolean;
  error: string | null;
  /** An older remote server can't serve history; only live entries appear. */
  historyUnavailable: boolean;
  canLoadEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  onOpenSession: (session: Session) => void;
  /** Every session (active + archived) across ready instances, for entry links. */
  sessions: Session[];
  instances: Instance[];
  projectsByInstance: Record<string, Project[]>;
  avatarIdentities: Record<string, AvatarIdentity>;
  blobStyle: BlobStyle;
  /** The host connection, so an empty log can say "Tower didn't answer" rather than "nothing". */
  connection: Parameters<typeof activityEmptyCopy>[0]['state'];
};

const formatTime = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * The durable activity log: day-grouped events from every instance, every line one click from the
 * session it describes. REST remains the source of truth for sessions and states; the log only
 * describes what happened, which is why it survives a restart and Home's cards don't.
 */
export default function ActivityTimeline({
  entries,
  loading,
  error,
  historyUnavailable,
  canLoadEarlier,
  loadingEarlier,
  onLoadEarlier,
  onOpenSession,
  sessions,
  instances,
  projectsByInstance,
  avatarIdentities,
  blobStyle,
  connection,
}: Props) {
  const sessionByKey = React.useMemo(() => sessionIndex(sessions), [sessions]);
  const projectNameByKey = React.useMemo(
    () =>
      new Map(
        sessions.map((session) => {
          const projects = projectsByInstance[session.instanceId] ?? [];
          return [sessionKey(session), projectForSession(session, projects)?.name] as const;
        })
      ),
    [sessions, projectsByInstance]
  );
  const dayGroups = React.useMemo(() => activityDayGroups(entries), [entries]);
  const instanceLabel = (instanceId: string): string =>
    instances.find((instance) => instance.id === instanceId)?.label ?? instanceId;
  const openTarget = (entry: ActivityEntry): Session | null => resolveActivityTarget(entry, sessionByKey);

  return (
    <div data-testid="activity-timeline" className="flex flex-col gap-2">
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
        >
          Couldn’t load history: {error}
        </p>
      ) : null}
      {historyUnavailable && entries.length === 0 ? (
        <p className="px-1 py-2 text-[12px] text-muted-foreground">
          This connection can’t serve activity history.
        </p>
      ) : null}

      {loading && entries.length === 0 ? (
        <div className="flex flex-col gap-1.5 py-2" aria-label="Loading activity">
          {[0, 1, 2, 3, 4].map((line) => (
            <div key={line} className="h-8 animate-pulse rounded-md bg-muted/40" />
          ))}
        </div>
      ) : null}

      {dayGroups.map((group) => (
        <div key={group.day} className="flex flex-col gap-0.5">
          <h3 className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{group.label}</h3>
          {group.rows.map((row) => (
            <TimelineRow
              key={row.kind === 'block' ? `block:${row.entries[0].id}` : `entry:${row.entry.id}`}
              row={row}
              openTarget={openTarget}
              sessionByKey={sessionByKey}
              projectNameByKey={projectNameByKey}
              instanceLabel={instanceLabel}
              avatarIdentities={avatarIdentities}
              blobStyle={blobStyle}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      ))}

      {entries.length === 0 && !loading ? (
        <p className="px-2 py-3 text-[12px] text-muted-foreground">
          {activityEmptyCopy({ state: connection, endpointCount: instances.length })}
        </p>
      ) : null}

      {canLoadEarlier || loadingEarlier ? (
        <button
          type="button"
          onClick={onLoadEarlier}
          disabled={!canLoadEarlier}
          className="mt-2 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-70"
        >
          {loadingEarlier ? <Loader2 className="size-3.5 animate-spin" /> : <History className="size-3.5" />}
          {loadingEarlier ? 'Loading earlier days…' : 'Load earlier days'}
        </button>
      ) : entries.length > 0 ? (
        <p className="px-2 pt-2 text-[11.5px] text-muted-foreground">No older activity recorded.</p>
      ) : null}
    </div>
  );
}

type TimelineRowProps = {
  row: ActivityRow;
  openTarget: (entry: ActivityEntry) => Session | null;
  sessionByKey: Map<string, Session>;
  projectNameByKey: Map<string, string | undefined>;
  instanceLabel: (instanceId: string) => string;
  avatarIdentities: Record<string, AvatarIdentity>;
  blobStyle: BlobStyle;
  onOpenSession: (session: Session) => void;
};

function TimelineRow({
  row,
  openTarget,
  sessionByKey,
  projectNameByKey,
  instanceLabel,
  avatarIdentities,
  blobStyle,
  onOpenSession,
}: TimelineRowProps) {
  if (row.kind === 'block') {
    const newest = row.entries[0];
    const target = openTarget(newest);
    const identity = newest.sessionId
      ? sessionByKey.get(sessionKey({ instanceId: newest.instanceId, sessionId: newest.sessionId }))
      : undefined;
    const seed = `${newest.instanceId}::${newest.sessionId ?? ''}`;
    const title =
      identity?.title ??
      (newest.sessionId
        ? projectNameByKey.get(sessionKey({ instanceId: newest.instanceId, sessionId: newest.sessionId }))
        : undefined) ??
      instanceLabel(newest.instanceId);
    const body = (
      <>
        <span className="w-[108px] flex-none text-right text-[11px] tabular-nums text-muted-foreground">
          {formatTime(row.from)} – {formatTime(row.to)}
        </span>
        <span className="flex flex-none items-center" aria-hidden="true">
          <Blob style={blobStyle} seed={seed} identity={avatarIdentities[seed]} size={22} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px]">
          <span className="font-medium">{title}</span>
          <span className="text-muted-foreground">
            {' — '}
            {row.count} tool {row.count === 1 ? 'call' : 'calls'} · last {entryLine(newest)}
          </span>
        </span>
      </>
    );
    return target ? (
      <button
        type="button"
        onClick={() => onOpenSession(target)}
        data-testid="activity-block"
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
      >
        {body}
      </button>
    ) : (
      <div
        data-testid="activity-block"
        data-muted="true"
        className="flex w-full items-center gap-2.5 rounded-md border border-dashed border-border/70 px-2 py-1.5 text-left text-muted-foreground"
      >
        {body}
      </div>
    );
  }

  const entry = row.entry;
  const target = openTarget(entry);
  const identity = entry.sessionId
    ? sessionByKey.get(sessionKey({ instanceId: entry.instanceId, sessionId: entry.sessionId }))
    : undefined;
  const seed = `${entry.instanceId}::${entry.sessionId ?? ''}`;
  const title =
    identity?.title ??
    (entry.sessionId
      ? projectNameByKey.get(sessionKey({ instanceId: entry.instanceId, sessionId: entry.sessionId }))
      : undefined) ??
    instanceLabel(entry.instanceId);
  const meta = identity
    ? [
        entry.sessionId
          ? projectNameByKey.get(sessionKey({ instanceId: entry.instanceId, sessionId: entry.sessionId }))
          : undefined,
        instanceLabel(entry.instanceId),
      ]
        .filter(Boolean)
        .join(' · ')
    : instanceLabel(entry.instanceId);
  const body = (
    <>
      <span className="w-[54px] flex-none text-right text-[11px] tabular-nums text-muted-foreground">
        {formatTime(entry.at)}
      </span>
      <span className="flex flex-none items-center" aria-hidden="true">
        <Blob style={blobStyle} seed={seed} identity={avatarIdentities[seed]} size={22} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px]">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground"> — {entryLine(entry)}</span>
        <span className="hidden text-[11px] text-muted-foreground md:inline"> · {meta}</span>
      </span>
    </>
  );
  return target ? (
    <button
      type="button"
      onClick={() => onOpenSession(target)}
      data-testid="activity-row"
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
    >
      {body}
    </button>
  ) : (
    <div
      data-testid="activity-row"
      data-muted="true"
      className="flex w-full items-center gap-2.5 rounded-md border border-dashed border-border/70 px-2 py-1.5 text-left text-muted-foreground"
    >
      {body}
    </div>
  );
}
