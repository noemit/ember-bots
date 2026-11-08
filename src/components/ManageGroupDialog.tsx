import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  canSaveGroup,
  defaultGroupName,
  groupMissingNote,
  MIN_GROUP_MEMBERS,
  missingGroupMembers,
} from '@/lib/sessionGroups';
import { isWorker } from '@/lib/crew';
import { randomId } from '@/lib/randomId';
import { sessionKey } from '../types';
import type { Instance, Session, SessionGroup } from '../types';

export type GroupDraft = {
  /** Present when editing an existing group; absent while creating one. */
  id?: string;
  name: string;
  keys: string[];
  primaryKey?: string;
};

type Props = {
  open: boolean;
  draft: GroupDraft | null;
  /** Every session Ember knows about, for the add list. */
  sessions: Session[];
  instances: Instance[];
  onOpenChange: (open: boolean) => void;
  onSave: (group: SessionGroup) => void;
  onUngroup: (groupId: string) => void;
};

/**
 * One panel for a group's members, its name and which member new agents follow. Creating a group is
 * the same panel with an empty list: adding the second member is what creates it, so "Group with…"
 * and "Manage group" share one surface.
 */
export default function ManageGroupDialog({
  open,
  draft,
  sessions,
  instances,
  onOpenChange,
  onSave,
  onUngroup,
}: Props) {
  const [name, setName] = React.useState('');
  const [keys, setKeys] = React.useState<string[]>([]);
  const [primaryKey, setPrimaryKey] = React.useState<string | undefined>(undefined);
  const [query, setQuery] = React.useState('');

  // Re-seed whenever the panel opens for a different group.
  React.useEffect(() => {
    if (!open) return;
    setName(draft?.name ?? '');
    setKeys(draft?.keys ?? []);
    setPrimaryKey(draft?.primaryKey ?? draft?.keys?.[0]);
    setQuery('');
  }, [open, draft]);

  const byKey = React.useMemo(() => new Map(sessions.map((s) => [sessionKey(s), s])), [sessions]);
  // `attachable` is the same test that decided whether that instance's sessions were read at all,
  // so it is also the honest answer to "is this member waiting on a connection?".
  const instanceFor = (instanceId: string) => {
    const instance = instances.find((candidate) => candidate.id === instanceId);
    return instance ? { label: instance.label, readable: instance.attachable } : undefined;
  };
  const labelOf = (session: Session): string =>
    instanceFor(session.instanceId)?.label ?? session.instanceId;
  const members = keys.flatMap((key) => byKey.get(key) ?? []);
  // Members the panel cannot show right now (an instance that is not answering, or one Ember no
  // longer lists). They stay in `keys`, so saving writes them back untouched.
  const missingNote = groupMissingNote(
    missingGroupMembers(keys, (key) => byKey.has(key), instanceFor)
  );
  const resolvedName = name.trim() || defaultGroupName(members.map((member) => member.title ?? member.id));
  const canSave = canSaveGroup(keys);

  const candidates = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions
      .filter((session) => !isWorker(session) && !session.archived && !keys.includes(sessionKey(session)))
      .filter((session) =>
        needle
          ? `${session.title ?? ''} ${session.directory ?? ''}`.toLowerCase().includes(needle)
          : true
      )
      .slice(0, 24);
  }, [sessions, keys, query]);

  const add = (session: Session) => setKeys((current) => [...current, sessionKey(session)]);
  const remove = (session: Session) => {
    const key = sessionKey(session);
    setKeys((current) => current.filter((entry) => entry !== key));
    setPrimaryKey((current) => (current === key ? undefined : current));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[520px] sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{draft?.id ? 'Manage group' : 'New group'}</DialogTitle>
          <DialogDescription>
            Any session, on any instance. Groups are Ember-side: nothing changes on the host.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={resolvedName}
            aria-label="Group name"
          />

          <div className="flex flex-col gap-1" aria-label="Group members" role="list">
            {keys.length < MIN_GROUP_MEMBERS ? (
              <p className="text-xs text-muted-foreground">
                Add at least {MIN_GROUP_MEMBERS} sessions. Choose a primary to decide where new
                bots for this group start.
              </p>
            ) : null}
            {members.map((member) => {
              const key = sessionKey(member);
              const primary = primaryKey === key;
              return (
                <div
                  key={key}
                  role="listitem"
                  className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{member.title ?? member.id}</span>
                  <span className="flex-none rounded-full border px-1.5 text-[9.5px] uppercase tracking-wide text-muted-foreground">
                    {labelOf(member)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPrimaryKey(key)}
                    aria-pressed={primary}
                    aria-label={`Make ${member.title ?? member.id} the primary for new bots`}
                    className={
                      primary
                        ? 'flex-none rounded px-1.5 text-[10px] font-semibold uppercase text-highlight'
                        : 'flex-none rounded px-1.5 text-[10px] uppercase text-muted-foreground hover:text-foreground'
                    }
                  >
                    {primary ? 'primary' : 'make primary'}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(member)}
                    aria-label={`Remove ${member.title ?? member.id} from the group`}
                    className="flex-none rounded px-1 text-xs text-muted-foreground hover:text-destructive"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          {missingNote ? (
            <p className="text-[11px] leading-snug text-muted-foreground" role="note">
              {missingNote}
            </p>
          ) : null}

          <div className="flex flex-col gap-1">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Add a session, from any instance…"
              aria-label="Search sessions to add"
            />
            <div className="max-h-40 overflow-y-auto">
              {candidates.map((session) => (
                <button
                  key={sessionKey(session)}
                  type="button"
                  onClick={() => add(session)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/60"
                >
                  <span className="min-w-0 flex-1 truncate">{session.title ?? session.id}</span>
                  <span className="flex-none text-[9.5px] uppercase tracking-wide text-muted-foreground">
                    {labelOf(session)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          {draft?.id ? (
            <Button
              variant="outline"
              className="mr-auto text-destructive"
              onClick={() => {
                onUngroup(draft.id as string);
                onOpenChange(false);
              }}
            >
              Ungroup
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              onSave({
                id: draft?.id ?? randomId(),
                name: resolvedName,
                keys,
                primaryKey: primaryKey && keys.includes(primaryKey) ? primaryKey : keys[0],
              });
              onOpenChange(false);
            }}
          >
            {draft?.id ? 'Done' : 'Create group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
