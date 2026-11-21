import {
  Box,
  CircleDashed,
  CircleDollarSign,
  EyeOff,
  Folder,
  MessageCircleQuestion,
  Minus,
  Moon,
  RefreshCw,
  ShieldAlert,
  UserPlus,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { normalizeDirectory } from '../../blob/seed';
import { crewCostLabel, crewCostTitle, type CrewCostState } from '../../lib/crewCost';
import type { PendingCreate } from '../../lib/pendingCreate';
import { COST_UNKNOWN_LABEL, COST_UNKNOWN_TITLE } from '../../lib/sessionCost';
import type {
  Instance,
  PermissionRequest,
  QuestionRequest,
  Session,
  ViewSettings,
  ViewSettingsPatch,
} from '../../types';
import { PermissionRulesButton } from '../PermissionRules';
import ViewMenu from '../ViewMenu';

type SessionHeaderProps = {
  session: Session;
  instance: Instance | null;
  active: boolean;
  connected: boolean;
  editingTitle: boolean;
  setEditingTitle: (editing: boolean) => void;
  commitRename: (value: string) => void;
  onRename?: (title: string) => void;
  instanceMarkerColor?: number;
  promotable: boolean;
  onPromote?: () => void;
  offerReload: boolean;
  reloading: boolean;
  onReload: () => void | Promise<void>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  sessionFolder?: string;
  costShown: boolean;
  costState: CrewCostState;
  view: ViewSettings;
  onViewChange: (patch: ViewSettingsPatch) => void;
  canEditInstructions: boolean;
  knownInstructions?: string;
  onEditInstructions?: () => void;
  notificationsMuted: boolean;
  onQuietChange?: (quiet: boolean) => void;
  onMinimize?: () => void;
  onSnooze?: () => void;
  snoozed: boolean;
  onArchive?: () => void;
};

export function SessionHeader({
  session,
  instance,
  active,
  connected,
  editingTitle,
  setEditingTitle,
  commitRename,
  onRename,
  instanceMarkerColor,
  promotable,
  onPromote,
  offerReload,
  reloading,
  onReload,
  permissions,
  questions,
  sessionFolder,
  costShown,
  costState,
  view,
  onViewChange,
  canEditInstructions,
  knownInstructions,
  onEditInstructions,
  notificationsMuted,
  onQuietChange,
  onMinimize,
  onSnooze,
  snoozed,
  onArchive,
}: SessionHeaderProps) {
  return (
    <header
      data-active={active}
      className="flex min-h-11 flex-none flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3 py-1 sm:px-4 data-[active=true]:bg-muted/25"
    >
      {instance?.kind === 'pi' ? (
        <PermissionRulesButton key={`${session.instanceId}:${session.id}`} instanceId={session.instanceId} sessionId={session.id} />
      ) : null}
      {editingTitle ? (
        <input
          autoFocus
          defaultValue={session.title ?? ''}
          aria-label="Rename session"
          className="min-w-0 flex-1 rounded-md border border-highlight/50 bg-background px-1.5 py-0.5 text-[13px] font-medium outline-none"
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitRename(event.currentTarget.value);
            else if (event.key === 'Escape') setEditingTitle(false);
          }}
          onBlur={(event) => commitRename(event.currentTarget.value)}
        />
      ) : (
        <span
          className={cn('min-w-[5.5rem] flex-1 truncate text-[13px] font-medium', onRename && 'cursor-text', connected && 'sr-only')}
          title={onRename ? `${session.title ?? session.id} — double-click to rename` : undefined}
          onDoubleClick={onRename ? () => setEditingTitle(true) : undefined}
          style={
            instanceMarkerColor === undefined
              ? undefined
              : {
                  textDecoration: 'underline',
                  textDecorationColor: `var(--instance-marker-${instanceMarkerColor})`,
                  textDecorationThickness: '2px',
                  textUnderlineOffset: '3px',
                }
          }
        >
          {session.title ?? session.id}
        </span>
      )}
      {promotable && onPromote ? (
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onPromote}
          aria-label="Promote to a persistent bot"
          title="Promote to a persistent bot: it becomes its own named bot others can message, and keeps running on its own"
        >
          <UserPlus aria-hidden="true" />
          Promote
        </Button>
      ) : null}
      {offerReload || reloading ? (
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={reloading}
          onClick={onReload}
          title="Reload this session from its instance"
        >
          <RefreshCw className={cn(reloading && 'animate-spin')} />
          <span className="hidden sm:inline">{reloading ? 'Reloading…' : 'Refresh'}</span>
        </Button>
      ) : null}
      {permissions.length ? (
        <Badge variant="secondary" className="border-warning/40 bg-warning/10 font-normal text-warning">
          <ShieldAlert />
          {permissions.length === 1 ? 'Approval needed' : `${permissions.length} approvals`}
        </Badge>
      ) : null}
      {questions.length ? (
        <Badge variant="secondary" className="border-highlight/40 bg-highlight/10 font-normal text-highlight">
          <MessageCircleQuestion />
          {questions.length === 1 ? 'Question needed' : `${questions.length} questions`}
        </Badge>
      ) : null}
      {instance ? (
        <Badge variant="secondary" className="hidden font-normal text-muted-foreground sm:inline-flex">
          <Box aria-hidden="true" />
          {instance.label}
        </Badge>
      ) : null}
      {sessionFolder ? (
        <Badge
          variant="secondary"
          className="hidden font-normal text-muted-foreground sm:inline-flex"
          title={session.directory}
        >
          <Folder aria-hidden="true" />
          {sessionFolder}
        </Badge>
      ) : null}
      {costState.kind === 'priced' ? (
        <Badge
          variant="secondary"
          className="hidden font-normal text-muted-foreground sm:inline-flex"
          title={crewCostTitle(costState)}
        >
          <CircleDollarSign aria-hidden="true" />
          {crewCostLabel(costState)}
        </Badge>
      ) : costState.kind === 'unknown' ? (
        <Badge
          variant="secondary"
          className="hidden font-normal text-muted-foreground sm:inline-flex"
          title={COST_UNKNOWN_TITLE}
        >
          <CircleDashed aria-hidden="true" />
          {COST_UNKNOWN_LABEL}
        </Badge>
      ) : null}
      {connected ? <span className="flex-1" aria-hidden="true" /> : null}
      <ViewMenu
        view={view}
        onChange={onViewChange}
        cost={costShown ? session.cost : undefined}
        costUnknown={costShown && costState.kind === 'unknown'}
        instructions={canEditInstructions ? knownInstructions ?? '' : undefined}
        onEditInstructions={canEditInstructions ? onEditInstructions : undefined}
        quiet={notificationsMuted}
        onQuietChange={onQuietChange}
      />
      {onMinimize || onArchive || onSnooze ? (
        <div className="flex items-center gap-0.5">
          {onMinimize ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={onMinimize} aria-label="Close this column">
                  <Minus className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Close this column: the session stays in the list</TooltipContent>
            </Tooltip>
          ) : null}
          {onSnooze ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onSnooze}
                  aria-label={snoozed ? 'Unsnooze session' : 'Snooze session'}
                  aria-pressed={snoozed}
                >
                  <Moon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {snoozed ? 'Unsnooze session' : 'Snooze session — work and notifications stay on'}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {onArchive ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={onArchive} aria-label="Hide session">
                  <EyeOff className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hide session</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

export function PendingCreateHeader({
  pending,
  draftInstance,
}: {
  pending: PendingCreate;
  draftInstance: Instance | null;
}) {
  return (
    <header className="flex min-h-11 flex-none flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3 py-1 sm:px-4">
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={pending.title}>
        {pending.title}
      </span>
      {draftInstance ? (
        <Badge variant="secondary" className="hidden font-normal text-muted-foreground sm:inline-flex">
          <Box aria-hidden="true" />
          {draftInstance.label}
        </Badge>
      ) : null}
      {pending.options.directory ? (
        <Badge
          variant="secondary"
          className="hidden font-normal text-muted-foreground sm:inline-flex"
          title={pending.options.directory}
        >
          <Folder aria-hidden="true" />
          {normalizeDirectory(pending.options.directory).split(/[\\/]/).filter(Boolean).pop()}
        </Badge>
      ) : null}
    </header>
  );
}
