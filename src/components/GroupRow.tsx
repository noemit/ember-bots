import { useAvatarSize } from '../blob/size';
import ProcessIndicator from './ProcessIndicator';
import RailDescription from './RailDescription';
import * as React from 'react';
import { Box, Group as GroupIcon, Plus, EyeOff } from 'lucide-react';
import { motion } from 'motion/react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ARCHIVE_AGE_OPTIONS, bulkArchiveTargets } from '@/lib/bulkArchive';
import type { GroupEntry } from '@/lib/projectGroups';
import { SessionContextMenuContent } from './SessionRow';
import Blob from '../blob/Blob';
import { sessionKey } from '../types';
import type { AvatarIdentity, BallMood, BlobStyle, Session } from '../types';

type Props = {
  entry: GroupEntry;
  previews?: Record<string, string>;
  /** Compact rows hide descriptions, except in the wide rail. */
  compact?: boolean;
  /** Instance label per id, for the footer's instance chips. */
  instanceLabels: Record<string, string>;
  instanceMarkers?: Record<string, number | undefined>;
  avatarIdentities: Record<string, AvatarIdentity>;
  moods: Record<string, BallMood>;
  /** Session keys shown as workspace columns; each visible member gets an underline. */
  visibleKeys: Set<string>;
  blobStyle: BlobStyle;
  /** Session keys with a reload in flight, so a member's menu can say "Reloading…" and disable. */
  reloadingKeys?: Set<string>;
  /** Session keys with an archive/restore in flight. */
  archivingKeys?: Set<string>;
  onOpen: () => void;
  /** Opens just the clicked member, adding it to the current workspace. */
  onOpenSession: (session: Session) => void;
  /** The "new agent in this group" action, when the group's primary member still resolves. */
  onNewAgent?: () => void;
  onReload: (session: Session) => void;
  onArchive: (session: Session, archived: boolean) => void;
  snoozedKeys?: ReadonlySet<string>;
  onSnooze?: (session: Session, snoozed: boolean) => void;
  /** Bulk archive from the `+N` menu; one notice/undo covers the whole batch. */
  onArchiveMany: (sessions: Session[]) => void;
  onCustomizeAppearance: (session: Session) => void;
  onManage?: () => void;
  onUngroup?: () => void;
};

/** Not memoized: it takes sets and records that change identity per render anyway. */
export default function GroupRow({
  entry,
  previews = {},
  compact = false,
  instanceLabels,
  instanceMarkers = {},
  avatarIdentities,
  moods,
  visibleKeys,
  blobStyle,
  reloadingKeys,
  archivingKeys,
  onOpen,
  onOpenSession,
  onNewAgent,
  onReload,
  onArchive,
  snoozedKeys,
  onSnooze,
  onArchiveMany,
  onCustomizeAppearance,
  onManage,
  onUngroup,
}: Props) {
  // Recomputed per render so the menu's counts stay current with the member list.
  const avatarSize = useAvatarSize(22);
  const inactiveTargets = bulkArchiveTargets(entry.members, moods, { now: Date.now() });

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.16 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }}
      role="button"
      tabIndex={0}
      aria-label={`Open group ${entry.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group/group cursor-pointer rounded-lg border bg-card/40 px-2 py-1.5 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-highlight"
    >
      <div className="flex items-center gap-1.5 px-1">
        <GroupIcon className="size-3 flex-none text-muted-foreground" aria-hidden="true" />
        {/* No name in the header, deliberately. A group created from "Group with…" is seeded with
            an empty name, and `defaultGroupName` returns the *member's own title* for a single-member
            group — so the header either drew nothing or repeated the first name in the list below it.
            The row keeps `aria-label` and a tooltip, so it still says what it is — the visible
            name is what went, not the accessible one. */}
        <span className="min-w-0 truncate text-[11.5px] font-semibold text-foreground">
          {entry.members.length} {entry.members.length === 1 ? 'bot' : 'bots'}
        </span>
        {onNewAgent ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onNewAgent();
                }}
                aria-label={`New session in ${entry.name}`}
                className="ml-auto flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">New session in {entry.name}</TooltipContent>
          </Tooltip>
        ) : null}
        {onManage ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onManage();
            }}
            aria-label={`Manage ${entry.name}`}
            className="flex-none rounded px-1.5 text-[10.5px] text-muted-foreground hover:text-foreground"
          >
            Manage
          </button>
        ) : null}
        {onUngroup ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onUngroup();
            }}
            aria-label={`Ungroup ${entry.name}`}
            className="flex-none rounded px-1.5 text-[10.5px] text-muted-foreground hover:text-destructive"
          >
            Ungroup
          </button>
        ) : null}
      </div>
      {/* Always drawn, like a project card. Hiding it in compact mode made a group the only
          rail entry with no faces at all — a bare name row — which read as a broken card rather
          than a denser one. Compact mode makes rows tighter; it should not make a group anonymous. */}
        {/* A **list**, not the project card's blob strip.
            The strip is a row of 48px blobs under a two-line, 10px chip clipped at 30px, which is
            right for a project — a folder of sessions you recognise by face. It is wrong for a
            group: you grouped these agents because their *names* matter, and "Habit onboarding QA ·
            copy pass" clipped to "Habit onboarding QA ·" makes two members indistinguishable.
            One row per member gives the title two readable lines, which is what the strip
            could never do at 320px however tall the chip grew. */}
        <ul className="mt-1 flex min-w-0 flex-col gap-0.5">
          {entry.members.map((member) => {
            const key = sessionKey(member);
            const active = visibleKeys.has(key);
            const markerColor = instanceMarkers[member.instanceId];
            return (
              <li key={key} className="min-w-0">
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    {/* A row is a button in its own right: the group row opens all of them, and a
                        member row opens that one. It stops the click from also opening the group. */}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenSession(member);
                      }}
                      title={`${member.title?.trim() || member.id}${member.archived ? ' (hidden)' : ''}`}
                      className={cn(
                        'flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-background/70 focus-visible:outline-2 focus-visible:outline-highlight',
                        active && 'bg-muted/60'
                      )}
                    >
                      {/* The bare blob, not `SessionBlob`: that component is a 56px column with
                          its own title chip, which would repeat the name this row already writes
                          and push it out of the way. A list row needs a face beside a name. */}
                      <span className="relative flex-none">
                        <Blob
                          style={blobStyle}
                          seed={key}
                          identity={avatarIdentities[key]}
                          size={avatarSize}
                          mood={moods[key] ?? 'unknown'}
                        />
                        {active ? (
                          <span
                            aria-hidden="true"
                            className="absolute -bottom-1 left-1/2 h-[2px] w-3 -translate-x-1/2 rounded-full bg-highlight"
                          />
                        ) : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span data-group-member-title="" data-instance-marker={markerColor}
                          style={markerColor === undefined ? undefined : {
                            textDecoration: 'underline',
                            textDecorationColor: `var(--instance-marker-${markerColor})`,
                            textDecorationThickness: '2px',
                            textUnderlineOffset: '3px',
                          }} data-session-title="" title={member.title?.trim() || member.id}
                          className="line-clamp-2 text-[11.5px] leading-4 text-foreground [overflow-wrap:anywhere]">
                          {member.title?.trim() || member.id}
                        </span>
                        <RailDescription preview={previews[key]} timestamp={member.updated} directory={member.directory} compact={compact} />
                      </span>
                      <ProcessIndicator session={member} />
                      {member.needsInput ? (
                        <span
                          className="size-1.5 flex-none rounded-full bg-highlight"
                          title="waiting on you"
                          aria-label="waiting on you"
                        />
                      ) : null}
                    </button>
                  </ContextMenuTrigger>
                  <SessionContextMenuContent
                    session={member}
                    reloading={reloadingKeys?.has(key) ?? false}
                    archiving={archivingKeys?.has(key) ?? false}
                    onReload={onReload}
                    onArchive={onArchive}
                    snoozed={snoozedKeys?.has(key)}
                    onSnooze={onSnooze}
                    onCustomizeAppearance={onCustomizeAppearance}
                  />
                </ContextMenu>
              </li>
            );
          })}
        </ul>
        <span className="mt-1 flex min-w-0 items-center gap-1 px-1">
          <Box className="size-2.5 flex-none text-muted-foreground" aria-hidden="true" />
          {entry.instanceIds.map((id) => (
            <span
              key={id}
              className="min-w-0 truncate rounded-full border px-1.5 text-[9.5px] leading-[15px] uppercase tracking-wide text-muted-foreground"
            >
              {instanceLabels[id] ?? id}
            </span>
          ))}
          {inactiveTargets.length > 0 ? (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  className="ml-auto flex-none rounded px-1 text-[10px] text-muted-foreground hover:text-foreground"
                  title={`Tidy up: ${inactiveTargets.length} inactive`}
                  onClick={(event) => event.stopPropagation()}
                >
                  Tidy up {inactiveTargets.length}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuLabel className="text-[11px] text-muted-foreground">
                  Hide inactive bots
                </ContextMenuLabel>
                <ContextMenuItem onSelect={() => onArchiveMany(inactiveTargets)}>
                  <EyeOff />
                  Hide {inactiveTargets.length} inactive
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuLabel className="text-[11px] text-muted-foreground">Hide older than…</ContextMenuLabel>
                {ARCHIVE_AGE_OPTIONS.map((option) => {
                  const targets = bulkArchiveTargets(entry.members, moods, {
                    olderThanHours: option.hours,
                    now: Date.now(),
                  });
                  return (
                    <ContextMenuItem
                      key={option.label}
                      disabled={targets.length === 0}
                      onSelect={() => onArchiveMany(targets)}
                    >
                      <EyeOff /><span>{option.label}</span>
                      <span className="ml-auto pl-3 tabular-nums text-muted-foreground">{targets.length}</span>
                    </ContextMenuItem>
                  );
                })}
              </ContextMenuContent>
            </ContextMenu>
          ) : null}
        </span>

    </motion.div>
  );
}
