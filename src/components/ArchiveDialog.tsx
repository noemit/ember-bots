import * as React from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { projectForSession } from '../blob/seed';
import SessionRow from './SessionRow';
import { sessionKey } from '../types';
import { instanceMarkerColor } from '../lib/instanceMarker';
import { archiveEmptyCopy, endpointState } from '../lib/instanceHealth';
import type {
  AvatarIdentity,
  BallMood,
  BlobStyle,
  Instance,
  InstanceDefaults,
  Project,
  Session,
} from '../types';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hidden sessions, across every connected instance. */
  sessions: Session[];
  projectsByInstance: Record<string, Project[]>;
  instances: Instance[];
  moods: Record<string, BallMood>;
  previews: Record<string, string>;
  avatarIdentities: Record<string, AvatarIdentity>;
  blobStyle: BlobStyle;
  instanceDefaults: Record<string, InstanceDefaults>;
  reloadingKeys: Set<string>;
  archivingKeys: Set<string>;
  /** Restores the session and opens it (archived sessions can't stay open). */
  onRestoreSession: (session: Session) => void;
  onReload: (session: Session) => void;
  onArchive: (session: Session, archived: boolean) => void;
  onCustomizeAppearance: (session: Session) => void;
};

export const HIDDEN_SESSIONS_INITIAL_CAP = 50;

export type ArchiveQueryAction =
  | { type: 'change'; query: string }
  | { type: 'openChange'; open: boolean };

export const archiveQueryReducer = (query: string, action: ArchiveQueryAction): string => {
  if (action.type === 'openChange') return action.open ? query : '';
  return action.query;
};

export const filterHiddenSessions = (
  sessions: readonly Session[],
  query: string,
  projectsByInstance: Record<string, Project[]>,
  previews: Record<string, string>,
): Session[] => {
  const ordered = [...sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  const needle = query.trim().toLowerCase();
  if (!needle) return ordered;
  return ordered.filter((session) => {
    const key = sessionKey(session);
    const title = session.title?.trim() || session.id;
    const projectName = projectForSession(session, projectsByInstance[session.instanceId] ?? [])?.name;
    return [title, projectName, session.directory, previews[key]].some((value) =>
      value?.toLowerCase().includes(needle)
    );
  });
};

export type ArchiveDialogBodyProps = Omit<Props, 'open' | 'onOpenChange'> & {
  query: string;
  onQueryChange: (query: string) => void;
  showAll?: boolean;
  onShowAll?: () => void;
};

export function ArchiveDialogBody({
  sessions,
  query,
  onQueryChange,
  showAll = false,
  onShowAll,
  projectsByInstance,
  instances,
  moods,
  previews,
  avatarIdentities,
  blobStyle,
  instanceDefaults,
  reloadingKeys,
  archivingKeys,
  onRestoreSession,
  onReload,
  onArchive,
  onCustomizeAppearance,
}: ArchiveDialogBodyProps) {
  const instanceById = Object.fromEntries(instances.map((instance) => [instance.id, instance]));
  const multiInstance = instances.filter((instance) => instance.attachable).length > 1;
  // An empty archive is a real answer only when the hosts answered. An outage must not read as
  // "you have nothing archived".
  const connection = endpointState(instances);
  const filtered = filterHiddenSessions(sessions, query, projectsByInstance, previews);
  const visibleSessions = showAll ? filtered : filtered.slice(0, HIDDEN_SESSIONS_INITIAL_CAP);
  const remainingCount = Math.max(0, filtered.length - visibleSessions.length);
  const trimmedQuery = query.trim();

  const renderSession = (session: Session) => {
    const key = sessionKey(session);
    return (
      <SessionRow
        key={key}
        session={session}
        instanceLabel={multiInstance ? instanceById[session.instanceId]?.label : undefined}
        projectName={projectForSession(session, projectsByInstance[session.instanceId] ?? [])?.name}
        // This is a reading dialog, not the normal-width rail: keep its descriptions.
        expanded
        preview={previews[key]}
        selected={false}
        mood={moods[key] ?? 'unknown'}
        reloading={reloadingKeys.has(key)}
        archiving={archivingKeys.has(key)}
        markerColor={instanceMarkerColor(session.instanceId, instanceDefaults[session.instanceId])}
        identity={avatarIdentities[key]}
        blobStyle={blobStyle}
        onSelect={onRestoreSession}
        onReload={onReload}
        onArchive={onArchive}
        onCustomizeAppearance={onCustomizeAppearance}
      />
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Hidden sessions</DialogTitle>
        <DialogDescription>
          Unhide a session to bring it back to the rail.
        </DialogDescription>
      </DialogHeader>

      {sessions.length > 0 ? (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            placeholder="Search hidden sessions…"
            aria-label="Search hidden sessions"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                event.stopPropagation();
                onQueryChange('');
              }
            }}
            className="h-8 pl-8 pr-7 text-xs shadow-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              onClick={() => onQueryChange('')}
              className="absolute top-1/2 right-1 -translate-y-1/2"
            >
              <X />
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2">
        {sessions.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">
            {archiveEmptyCopy({ state: connection, endpointCount: instances.length })}
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">
            No hidden sessions match “{trimmedQuery}”.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {visibleSessions.map(renderSession)}
            {remainingCount > 0 ? (
              <button
                type="button"
                onClick={onShowAll}
                className="mt-1 rounded-md px-3 py-2 text-center text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                Show {remainingCount} older hidden {remainingCount === 1 ? 'session' : 'sessions'}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

/** Global archive: every archived session as an individual row, newest first, with restore. */
export default function ArchiveDialog({
  open,
  onOpenChange,
  ...bodyProps
}: Props) {
  const [query, dispatchQuery] = React.useReducer(archiveQueryReducer, '');
  const [showAll, setShowAll] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      dispatchQuery({ type: 'openChange', open: false });
      setShowAll(false);
    }
  }, [open]);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setShowAll(false);
      dispatchQuery({ type: 'openChange', open: nextOpen });
      onOpenChange(nextOpen);
    },
    [onOpenChange]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-[520px]">
        <ArchiveDialogBody
          {...bodyProps}
          query={open ? query : ''}
          onQueryChange={(next) => dispatchQuery({ type: 'change', query: next })}
          showAll={open && showAll}
          onShowAll={() => setShowAll(true)}
        />
      </DialogContent>
    </Dialog>
  );
}
