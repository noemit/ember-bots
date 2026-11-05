import * as React from 'react';
import { ChevronDown, House, Menu, RefreshCw, Search, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { shortcutLabel } from '@/lib/shortcuts';
import { instanceReady, readyInstanceCount } from '@/lib/instanceHealth';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Instance, InstanceStatus } from '../types';

type Props = {
  instances: Instance[];
  hidden: Set<string>;
  /** Instances whose event stream is up; the rest fall back to fast polling. */
  live: Record<string, boolean>;
  refreshing: boolean;
  /** Transient error/notice toasts, rendered inline next to the search button. */
  banner?: React.ReactNode;
  onToggle: (instanceId: string) => void;
  onToggleNavigation: () => void;
  onOpenCommandPalette: () => void;
  onRefresh: () => void;
  onOpenSettings: () => void;

  /** The activity home: default when nothing is open, explicit toggle over open columns. */
  onToggleActivity: () => void;
  /** True while the home screen is showing. */
  activityActive: boolean;
  /** Back to the workspace (rail + columns); opens the most recent session if none is open. */
  onShowSessions: () => void;
  /** The usage view, as a sibling of Home rather than a dialog over it. */
  onShowUsage: () => void;
  usageActive: boolean;

  /** Unread messages across every session, for Home's one counter. */
  unreadMessages?: number;
  /** Home has no rail, so the drawer toggle would open nothing. */
  hideNavigation?: boolean;
};

/** One view in the top bar's tab group. A button, not an ARIA tab: it switches a view far from here. */
function ViewTab({
  active,
  onClick,
  label,
  ariaLabel,
  title,
  icon,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  ariaLabel: string;
  title: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      title={title}
      className={cn(
        'flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
      {badge}
    </button>
  );
}

/**
 * What kind of host this is, in the words the product uses.
 *
 * `pi` is Ember's own harness — the one this app is built around — so it is named for the product
 * rather than for the protocol ("pi"). The rest are OpenChamber instances, which Ember still speaks
 * to: calling them "local"/"remote"/"ssh" described how they are reached, not what answered, and a
 * person reading the row had no way to tell the two kinds of host apart at a glance.
 */
const kindLabel: Record<Instance['kind'], string> = {
  local: 'openchamber',
  remote: 'openchamber',
  ssh: 'openchamber',
  relay: 'openchamber',
  pi: 'ember-harness',
};

const statusLabel: Record<InstanceStatus, string> = {
  checking: 'checking connection…',
  ready: 'connected',
  unreachable: 'not connected, check the instance',
  unsupported: 'this instance needs its own openchamber',
};

const statusDot: Record<InstanceStatus, string> = {
  checking: 'bg-muted-foreground/50 animate-pulse',
  ready: 'bg-success',
  unreachable: 'bg-muted-foreground/50',
  unsupported: 'bg-muted-foreground/30',
};

// macOS traffic lights sit inside the inset title bar; leave room for them.
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export default function InstanceBar({
  instances,
  hidden,
  live,
  refreshing,
  banner,
  onToggle,
  onToggleNavigation,
  onOpenCommandPalette,
  onRefresh,
  onOpenSettings,
  onToggleActivity,
  activityActive,
  onShowSessions,
  onShowUsage,
  usageActive,
  unreadMessages = 0,
  hideNavigation = false,
}: Props) {
  // Same predicate the dropdown's per-row dot and `statusLabel` use: a host in its probe grace
  // period (`status: 'unreachable'`, `attachable: true`) counts as not connected in both places.
  const connected = readyInstanceCount(instances);

  return (
    <div
      className={cn(
        'safe-top-bar drag-region flex flex-none items-center gap-2 border-b bg-card pr-[max(0.75rem,env(safe-area-inset-right))]',
        isMac ? 'pl-3 md:pl-[76px]' : 'pl-[max(0.75rem,env(safe-area-inset-left))]'
      )}
    >
      {hideNavigation ? null : (
        <button
          type="button"
          onClick={onToggleNavigation}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
          aria-label="Toggle sessions sidebar"
        >
          <Menu className="size-4" />
        </button>
      )}
      <span className="mr-1 text-[13px] font-semibold tracking-wide text-highlight">
        {window.ember.appName ?? 'Ember'}
      </span>
      <Tooltip><TooltipTrigger asChild><button
        type="button"
        onClick={onOpenCommandPalette}
        className="no-drag flex h-7 items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Open command palette"
        aria-keyshortcuts="Meta+K Control+K"
      >
        <Search className="size-3.5" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded bg-background px-1 text-[10px] sm:inline">{shortcutLabel('Mod+K')}</kbd>
      </button></TooltipTrigger><TooltipContent>{shortcutLabel('Search sessions and notes · Mod+K')}</TooltipContent></Tooltip>

      {banner ? (
        <div className="no-drag flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {banner}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {/* The three views, side by side: a tab bar, not a row of toggles. */}
      <div
        role="group"
        aria-label="Views"
        className="no-drag flex h-7 flex-none items-center gap-0.5 rounded-full border bg-muted/50 p-0.5"
      >
        <ViewTab
          active={activityActive}
          onClick={onToggleActivity}
          label="Home"
          ariaLabel="Home — unread messages and recent activity"
          title="Unread messages, and what happened while you were away"
          icon={<House className="size-3.5" />}
          badge={
            unreadMessages > 0 ? (
              <span
                data-testid="unread-count"
                className="grid min-w-4 place-items-center rounded-full bg-highlight px-1 text-[10px] font-semibold tabular-nums text-highlight-foreground"
                title={`${unreadMessages} unread ${unreadMessages === 1 ? 'message' : 'messages'}`}
              >
                {unreadMessages}
              </span>
            ) : null
          }
        />
        <ViewTab
          active={!activityActive && !usageActive}
          onClick={onShowSessions}
          label="Sessions"
          ariaLabel="Sessions — the workspace and its columns"
          title="The workspace: open sessions and their columns"
        />
        <ViewTab
          active={usageActive}
          onClick={onShowUsage}
          label="Usage"
          ariaLabel="Usage — model calls and reported cost"
          title="What each model has been doing"
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-full border bg-muted/60 px-2.5 text-[12px] transition-colors hover:bg-muted"
            aria-label="Instances"
          >
            <span className={cn('size-1.5 rounded-full', connected > 0 ? 'bg-success' : 'bg-muted-foreground/50')} />
            <span className="tabular-nums">
              {instances.length === 0 ? 'No instances' : `${connected}/${instances.length} instances`}
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-[min(320px,calc(100vw-1rem))]">
          {instances.length === 0 ? (
            <div className="px-2 py-3 text-[12px] text-muted-foreground">
              No instances in ~/.config/openchamber/settings.json
            </div>
          ) : (
            <>
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                Connected instances show their sessions; untick one to hide it.
              </DropdownMenuLabel>
              {instances.map((instance) => (
                <DropdownMenuCheckboxItem
                  key={instance.id}
                  checked={instanceReady(instance) && !hidden.has(instance.id)}
                  // A host that is not ready cannot be toggled: it has no sessions to show or hide,
                  // and the row already says why ("not connected, check the instance").
                  disabled={!instanceReady(instance)}
                  // Keep the menu open so several can be toggled in a row.
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => onToggle(instance.id)}
                  className="items-start py-1.5"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                      <span className={cn('size-1.5 flex-none rounded-full', statusDot[instance.status])} />
                      <span className="truncate">{instance.label}</span>
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {kindLabel[instance.kind]}
                      {instance.url ? ` · ${instance.url}` : ''}
                      {instance.version ? ` · ${instance.version}` : ''}
                      {' · '}
                      {instance.status === 'ready'
                        ? live[instance.id]
                          ? 'live'
                          : 'polling'
                        : statusLabel[instance.status]}
                    </span>
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              onRefresh();
            }}
            disabled={refreshing}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
            {refreshing ? 'Reprobing…' : 'Reprobe instances'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenSettings}>
            <Settings />
            Instance settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
