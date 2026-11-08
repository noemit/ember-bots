import * as React from 'react';
import { Bell, BellOff, MoreHorizontal } from 'lucide-react';
import { formatCost } from './Transcript';
import { presetFor } from '../lib/instructionPresets';
import { COST_UNKNOWN_LABEL, COST_UNKNOWN_TITLE } from '../lib/sessionCost';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toolMenuOptions } from '../lib/toolDisplay';
import type { ViewSettings, ViewSettingsPatch } from '../types';

type Props = {
  view: ViewSettings;
  onChange: (patch: ViewSettingsPatch) => void;
  /** USD this session has spent, when the host reports it. Shown as one line of data. */
  cost?: number;
  /**
   * The session has run but the host's ledger reported no cost, so spend is unknown. Said out loud
   * here for the same reason the header badge says it: silence reads as "this was free".
   */
  costUnknown?: boolean;
  /** This session's standing instructions, when the host keeps them. `''` means none are added. */
  instructions?: string;
  /** Opens the editor for them; absent when the host has no per-session prompt. */
  onEditInstructions?: () => void;
  /**
   * Whether new messages in this session are marked read as they arrive ("Don't notify") or appear
   * on Home as unread ("Notify"). Absent where the session cannot hold a read mark (a draft, a
   * worker Home never lists).
   */
  quiet?: boolean;
  /** Toggle it. */
  onQuietChange?: (quiet: boolean) => void;
};

const DEFAULTS: ViewSettingsPatch = {
  showActivityRail: true,
  reasoningDisplay: 'collapsed',
  hideToolCalls: false,
  showQuestions: true,
  expandToolCalls: false,
  toolDisplay: 'collapsed',
  showMessageDetails: true,
  compactSpacing: false,
  compactRail: false,
  autoFollow: true,
};

/**
 * A checkbox item that leaves the menu open. Radix closes a menu on select, but these are display
 * toggles you set several of in a row, so the default close is prevented.
 */
const ViewToggle = ({
  checked,
  disabled,
  onCheckedChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: React.ReactNode;
}) => (
  <DropdownMenuCheckboxItem
    checked={checked}
    disabled={disabled}
    onCheckedChange={onCheckedChange}
    onSelect={(event) => event.preventDefault()}
  >
    {children}
  </DropdownMenuCheckboxItem>
);

/**
 * One eye menu for every transcript/rail display choice. Toggles read positively ("Show …") so the
 * menu says what is on; thinking visibility and default expansion are two independent switches,
 * where the old control was a single 3-way cycle. The eye is struck through when something is
 * hidden, so a collapsed view is never a mystery.
 */
export default function ViewMenu({
  view,
  onChange,
  cost,
  costUnknown,
  instructions,
  onEditInstructions,
  quiet,
  onQuietChange,
}: Props) {
  const showThinking = view.reasoningDisplay !== 'hidden';
  const expandThinking = view.reasoningDisplay === 'expanded';
  const showToolCalls = !view.hideToolCalls;
  const toolOptions = toolMenuOptions(view);
  const anythingHidden =
    !showThinking || !showToolCalls || !view.showQuestions || !view.showMessageDetails;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="relative h-7 px-2 text-xs"
          aria-label="View options"
          title="View options — what the transcript and rail show"
        >
          <MoreHorizontal className="size-3.5" />
          {/* An ellipsis says "there is more here"; it cannot say "something is hidden" the way a
              struck-through eye did. A dot keeps that signal rather than losing it. */}
          {anythingHidden ? (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-highlight" aria-hidden="true" />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {(cost !== undefined && cost > 0) || costUnknown || onEditInstructions || onQuietChange ? (
          <>
            <DropdownMenuLabel>This session</DropdownMenuLabel>
            {cost !== undefined && cost > 0 ? (
              <div className="flex items-baseline justify-between px-2 pb-1.5 text-xs text-muted-foreground">
                Spent
                <span className="font-medium text-foreground">{formatCost(cost)}</span>
              </div>
            ) : costUnknown ? (
              <div className="flex items-baseline justify-between gap-2 px-2 pb-1.5 text-xs text-muted-foreground">
                Spent
                <span className="text-right font-medium text-foreground" title={COST_UNKNOWN_TITLE}>
                  {COST_UNKNOWN_LABEL}
                </span>
              </div>
            ) : null}
            {onQuietChange ? (
              // A row rather than a checkbox: both states are sentences a person can read ("so this
              // session never shows as unread") instead of a switch whose off position has to be
              // guessed. It replaced a bell button whose label never fitted the header row.
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  onQuietChange(!quiet);
                }}
                className="items-start gap-2 py-1.5"
              >
                {quiet ? <Bell /> : <BellOff />}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{quiet ? 'New messages: Notify' : "New messages: Don't notify"}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {quiet
                      ? 'Unread messages appear in the rail.'
                      : 'Unread messages stay unread; this session stops raising notification indicators.'}
                  </span>
                </span>
              </DropdownMenuItem>
            ) : null}
            {onEditInstructions ? (
              <div className="flex items-baseline justify-between gap-2 px-2 pb-1.5 text-xs text-muted-foreground">
                {/* What the agent is for lives here now, not in the composer: this line says what is
                    in force and the button opens the editor. */}
                <span className="shrink-0">Instructions</span>
                <span className="min-w-0 truncate text-right font-medium text-foreground" title={instructions || undefined}>
                  {presetFor(instructions)?.name ?? (instructions?.trim() ? 'Custom' : 'Pi classic')}
                </span>
                <button
                  type="button"
                  onClick={onEditInstructions}
                  className="flex-none rounded px-1 text-[11px] underline-offset-2 hover:text-foreground hover:underline"
                >
                  Edit
                </button>
              </div>
            ) : null}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel>Thinking</DropdownMenuLabel>
        <ViewToggle
          checked={showThinking}
          onCheckedChange={(on) => onChange({ reasoningDisplay: on ? (expandThinking ? 'expanded' : 'collapsed') : 'hidden' })}
        >
          Show thinking blocks
        </ViewToggle>
        <ViewToggle
          checked={expandThinking}
          disabled={!showThinking}
          onCheckedChange={(on) => onChange({ reasoningDisplay: on ? 'expanded' : 'collapsed' })}
        >
          Expand thinking blocks
        </ViewToggle>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Content</DropdownMenuLabel>
        <ViewToggle checked={view.showQuestions} onCheckedChange={(on) => onChange({ showQuestions: on })}>
          Show question &amp; answer blocks
        </ViewToggle>
        <ViewToggle checked={showToolCalls} onCheckedChange={(on) => onChange({ hideToolCalls: !on })}>
          Show tool use
        </ViewToggle>
        {/* Both tool options are meaningless with tool use hidden, so `toolMenuOptions` omits them
            rather than disabling them: a greyed-out checkbox for something that would change
            nothing either way is a switch that lies about what it would do. */}
        {toolOptions.map((option) => (
          <ViewToggle
            key={option.id}
            checked={option.checked}
            onCheckedChange={(on) =>
              onChange(
                option.id === 'listAll'
                  ? { toolDisplay: on ? 'list' : 'collapsed' }
                  : { expandToolCalls: on }
              )
            }
          >
            {option.label}
          </ViewToggle>
        ))}
        <ViewToggle checked={view.showMessageDetails} onCheckedChange={(on) => onChange({ showMessageDetails: on })}>
          Show message details
        </ViewToggle>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Layout</DropdownMenuLabel>
        <ViewToggle
          checked={view.showActivityRail}
          onCheckedChange={(on) => onChange({ showActivityRail: on })}
        >
          Activity rail in the transcript
        </ViewToggle>
        <ViewToggle checked={view.compactSpacing} onCheckedChange={(on) => onChange({ compactSpacing: on })}>
          Compact spacing
        </ViewToggle>
        <ViewToggle checked={view.compactRail} onCheckedChange={(on) => onChange({ compactRail: on })}>
          Compact rail
        </ViewToggle>
        <ViewToggle checked={view.autoFollow} onCheckedChange={(on) => onChange({ autoFollow: on })}>
          Follow new content while streaming
        </ViewToggle>

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onChange(DEFAULTS)}>Reset to defaults</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
