import YoloLabel from './YoloLabel';
import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { springTransition } from '@/lib/animation';
import Blob from '../blob/Blob';
import { moodFrom } from '../blob/mood';
import { seedIdentity } from '../blob/seed';
import { sessionKey } from '../types';
import {
  brickStatusSignal,
  splitCrew,
  workerStateLabel,
  type BlockedWorker,
  type CrewBrickTone,
  type CrewWorkerStatus,
} from '../lib/crew';
import type { AvatarIdentity, BallState, BlobStyle, Session } from '../types';

type Props = {
  /** The leader's workers, newest activity first as the session list returns them. */
  workers: Session[];
  /** Inspect a thread in its modal, or open its promoted bot in the workspace. */
  onOpenWorker: (session: Session) => void;
  /** Resolve a promoted worker's peer session (same instance) so the brick links to it. */
  peerFor?: (worker: Session) => Session | null;
  /** Blob renderer style for promoted bot links; unpromoted threads have no avatar. */
  blobStyle: BlobStyle;
  /** Coarse ball state per worker, from the instance's status poll; missing reads as idle. */
  stateFor?: (session: Session) => BallState;
  /** Per-session YOLO data must change identity through memoized ChatView and this strip. */
  autoAcceptByKey?: Readonly<Record<string, boolean>>;
  /** Toggle a worker's auto-accept; omit to render the chip read-only. */
  onToggleYolo?: (session: Session, enabled: boolean) => void;
  /**
   * Workers **below** this leader's direct crew that are blocked on the human, at any depth, from
   * `blockedWorkersUnder` in `lib/crew`. They ride alongside the direct bricks; each one opens the
   * conversation that is actually waiting.
   */
  nestedBlocked?: BlockedWorker[];
  /**
   * The blob identity the rail resolves for a promoted bot (project colour, avatar override,
   * scheduled binding), so its chip matches its workspace avatar. Threads draw no blob.
   */
  identityFor?: (session: Session) => AvatarIdentity | undefined;
  /** Retained caller compatibility; neutral rows no longer tint their surfaces by leader. */
  leaderIdentity?: AvatarIdentity;
  /** The leader's title, for the strip's accessible name and the collapsed pill's tooltip. */
  leaderTitle?: string;
};

/**
 * The compact status signal: a 6px dot for the states that only need a colour, the word itself for
 * `needs input`. `unknown` draws a hollow dashed ring — the same "no verdict" reading its dashed
 * badge had.
 */
const BRICK_DOT: Record<CrewBrickTone, string> = {
  // Not used for `attention` (it prints its word), kept so the map stays total.
  attention: 'bg-highlight',
  active: 'bg-highlight',
  done: 'bg-success',
  quiet: 'bg-muted-foreground/40',
  failed: 'bg-destructive',
  unknown: 'border border-dashed border-muted-foreground/60',
};

/** Flat thread rows share the queue's readable preview and fine separators. */
export const BRICK_CLASS =
  'group/brick flex min-w-0 items-start gap-2 px-1.5 py-2 text-[12.5px] text-foreground';

/**
 * One worker, as a brick. Bricks stay memoized so a poll that leaves the strip untouched doesn't
 * re-render (or re-seed a blob for) every one of them; the blob identity is derived here so the
 * caller stays a plain list.
 */
const WorkerBrick = React.memo(function WorkerBrick({
  worker,
  blobStyle,
  state,
  status,
  auto,
  peer,
  onOpen,
  onToggleYolo,
  identityFor,
}: {
  worker: Session;
  blobStyle: BlobStyle;
  state: BallState;
  status: CrewWorkerStatus;
  auto: boolean;
  /** The promoted peer this brick links to; null when the worker isn't promoted or it isn't loaded. */
  peer: Session | null;
  onOpen: (session: Session) => void;
  onToggleYolo?: (session: Session, enabled: boolean) => void;
  identityFor?: (session: Session) => AvatarIdentity | undefined;
}) {
  // A promoted brick is a link to the peer fork; without the peer loaded it still opens the worker.
  const promoted = worker.promotedTo !== undefined;
  const linkTarget = peer ?? worker;
  // Only promoted bots draw an avatar. Resolve the same identity their workspace uses;
  // the thread chip's inherited leader tint must not recolour that bot.
  const identity = React.useMemo(
    () => identityFor?.(linkTarget) ?? seedIdentity(sessionKey(linkTarget)),
    [identityFor, linkTarget]
  );
  const mood = React.useMemo(
    () => moodFrom(state, worker.needsInput ? 'question' : undefined, false),
    [state, worker.needsInput]
  );
  const title = worker.title?.trim() || `Worker ${worker.id}`;
  const signal = brickStatusSignal(status);
  // The brick's accessible name stays the worker's title — that is what a human, an agent and a test
  // look a worker up by — and the status rides along as its *description*, so a screen reader still
  // announces "Parse config, working" without the name growing a word per row.
  const statusId = React.useId();
  const hint = promoted ? ('Open the persistent bot for ' + title) : ('Open ' + title);
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={springTransition}
      data-crew-brick=""
      data-worker-status={status}
      className={BRICK_CLASS}
    >
      <button
        type="button"
        onClick={() => onOpen(linkTarget)}
        title={`${hint} — ${signal.word}`}
        aria-label={title}
        aria-describedby={statusId}
        className="flex min-w-0 flex-1 items-start gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {promoted ? <Blob
          style={blobStyle}
          seed={sessionKey(linkTarget)}
          identity={identity}
          size={16}
          mood={mood}
          interactive={false}
        /> : null}
        <span className="min-w-0 flex-1">
          <span data-tray-preview="" className="line-clamp-2 leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">{title}</span>
          <span data-tray-meta="" className="mt-1 flex items-center gap-1.5 text-[10.5px] leading-4 text-muted-foreground">
            <span aria-hidden="true" className={cn('size-1.5 flex-none rounded-full', BRICK_DOT[signal.tone])} />
            <span id={statusId} className={cn(signal.tone === 'attention' && 'font-medium text-highlight', signal.tone === 'failed' && 'text-destructive')}>
              {signal.word}
            </span>
          </span>
        </span>
      </button>
      {promoted ? (
        <span
          className="flex-none rounded-sm border border-highlight/50 px-1 text-[9.5px] leading-4 font-semibold text-highlight uppercase"
          title="This thread is a persistent bot now — others can message it by name"
        >
          bot
        </span>
      ) : (
        <>
          {/* YOLO, spelled the way the composer spells it: the same shield, the same word, and the
              same collapse (the word goes at narrow widths, the shield stays). It used to read
              "auto", which named the mechanism rather than the mode, so the same thing looked like
              two different features in the two places it appears. */}
          {auto ? (
            onToggleYolo ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-pressed
                aria-label={`Turn off YOLO mode for ${title}`}
                title="YOLO mode is on for this worker: permission prompts are accepted automatically — click to turn it off"
                onClick={() => onToggleYolo(worker, false)}
                className="mt-1 h-5 max-sm:h-8 flex-none items-center gap-0.5 rounded-sm bg-warning/15 px-1 text-[9.5px] leading-4 font-semibold tracking-wide text-warning uppercase hover:bg-warning/25"
              >
                <YoloLabel small labelClassName="hidden @[420px]:inline" />
              </Button>
            ) : (
              <span
                className="flex flex-none items-center gap-0.5 px-1 text-[9.5px] leading-4 font-semibold text-warning uppercase"
                title="YOLO mode is on for this worker"
              >
                <YoloLabel small labelClassName="hidden @[420px]:inline" />
              </span>
            )
          ) : onToggleYolo ? (
            // Off is not worth a chip in a wrapped row of bricks: the control is there on hover
            // (and for a keyboard as soon as it is focused), and the on state is what must read.
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-pressed={false}
              aria-label={`Turn on YOLO mode for ${title}`}
              title="Turn on YOLO mode for this worker"
              onClick={() => onToggleYolo(worker, true)}
              className="mt-1 h-5 max-sm:h-8 flex-none items-center gap-0.5 rounded-sm px-1 text-[9.5px] leading-4 font-semibold tracking-wide text-muted-foreground uppercase opacity-100 [@media(min-width:640px)_and_(hover:hover)_and_(pointer:fine)]:opacity-0 max-sm:opacity-100 hover:text-foreground focus-visible:opacity-100 group-focus-within/brick:opacity-100 group-hover/brick:opacity-100"
            >
              <YoloLabel small labelClassName="hidden @[420px]:inline" />
            </Button>
          ) : null}
        </>
      )}
    </motion.li>
  );
});

/**
 * A worker somewhere below this leader that is blocked on the human. The strip only lists the
 * leader's own workers, so a sub-agent's question used to be invisible unless you opened the worker
 * above it; this brick names it here and opens the conversation that is actually waiting.
 *
 * The status and depth sit below the readable title, without a card or a thread avatar.
 */
const BlockedWorkerBrick = React.memo(function BlockedWorkerBrick({
  entry,
  blobStyle,
  state,
  onOpen,
  identityFor,
}: {
  entry: BlockedWorker;
  blobStyle: BlobStyle;
  state: BallState;
  onOpen: (session: Session) => void;
  identityFor?: (session: Session) => AvatarIdentity | undefined;
}) {
  const worker = entry.worker;
  const identity = React.useMemo(
    () => identityFor?.(worker) ?? seedIdentity(sessionKey(worker)),
    [identityFor, worker]
  );
  const mood = React.useMemo(() => moodFrom(state, worker.needsInput ? 'question' : undefined, false), [state, worker.needsInput]);
  const title = worker.title?.trim() || `Worker ${worker.id}`;
  const nested = entry.depth > 1;
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={springTransition}
      data-crew-brick=""
      data-worker-status="needs input"
      className={BRICK_CLASS}
    >
      <button
        type="button"
        onClick={() => onOpen(worker)}
        title={`${nested ? `Open ${title} (crew depth ${entry.depth})` : `Open ${title}`} — needs input`}
        aria-label={`${title} needs input — open the conversation to answer`}
        className="flex min-w-0 flex-1 items-start gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {worker.promotedTo ? <Blob
          style={blobStyle}
          seed={sessionKey(worker)}
          identity={identity}
          size={16}
          mood={mood}
          interactive={false}
        /> : null}
        <span className="min-w-0 flex-1">
          <span data-tray-preview="" className="line-clamp-2 leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">{title}</span>
          <span data-tray-meta="" className="mt-1 flex flex-wrap gap-1.5 text-[10.5px] leading-4 text-muted-foreground">
            <span className="font-medium text-highlight">needs input</span>
            {nested ? <span title={String(entry.depth) + " levels below this bot"}>Nested · depth {entry.depth}</span> : null}
          </span>
        </span>
      </button>
    </motion.li>
  );
});

/**
 * The Threads tray is a flat list, with readable titles and status beneath. Direct workers keep
 * their open/YOLO controls; nested blocked conversations remain reachable without an avatar.
 * Finished workers stay behind Previous. Only promoted peer links retain their blob.
 */
const CrewStrip = React.memo(function CrewStrip({
  workers,
  onOpenWorker,
  peerFor,
  blobStyle,
  stateFor,
  autoAcceptByKey,
  onToggleYolo,
  nestedBlocked = [],
  identityFor,
  leaderTitle,
}: Props) {
  // Live work remains visible; finished workers are an explicit expansion.
  const { live, previous } = splitCrew(workers, stateFor);
  const [previousOpen, setPreviousOpen] = React.useState(false);
  // A blocked worker that is already one of this strip's own bricks is announced by that brick's
  // status; only the ones further down need a brick of their own here. (It reads `workers`, not the
  // live list: a worker behind the "+N previous" chip still has its own brick waiting.)
  const crewKeys = React.useMemo(() => new Set(workers.map((worker) => sessionKey(worker))), [workers]);
  const extraBlocked = React.useMemo(
    () => nestedBlocked.filter((entry) => !crewKeys.has(sessionKey(entry.worker))),
    [nestedBlocked, crewKeys]
  );

  if (workers.length === 0 && extraBlocked.length === 0) return null;

  const brick = (worker: Session) => {
    const state: BallState = stateFor?.(worker) ?? (worker.needsInput ? 'needs-input' : 'unknown');
    return (
      <WorkerBrick
        key={sessionKey(worker)}
        worker={worker}
        blobStyle={blobStyle}
        state={state}
        status={workerStateLabel(worker, { state })}
        auto={autoAcceptByKey?.[sessionKey(worker)] === true}
        peer={worker.promotedTo !== undefined ? peerFor?.(worker) ?? null : null}
        onOpen={onOpenWorker}
        onToggleYolo={onToggleYolo}
        identityFor={identityFor}
      />
    );
  };

  return (
    /* One flat list; status stays beneath each title. The shelf owns opening and folding. */
    <div
      role="group"
      aria-label={leaderTitle ? `Crew of ${leaderTitle}` : 'Crew'}
      className="group/strip @container min-w-0"
    >
      {/* Bound large crews like Queue/Notes. Every row, Previous and nested question stays in
          the same keyboard-scrollable list; nothing is sampled or clipped out of the DOM. */}
      <ul
        tabIndex={0}
        aria-label="Thread conversations"
        className="flex max-h-48 min-w-0 list-none flex-col divide-y divide-border/50 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <AnimatePresence initial={false} mode="popLayout">
          {live.map(brick)}
        </AnimatePresence>
        {previous.length > 0 ? (
          <li className="min-w-0">
            <button
              type="button"
              onClick={() => setPreviousOpen((open) => !open)}
              aria-expanded={previousOpen}
              title={
                previousOpen
                  ? 'Hide previous worker chats'
                  : `${previous.length} finished worker ${previous.length === 1 ? 'chat' : 'chats'}`
              }
              className="inline-flex items-center px-1.5 py-2 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {previousOpen ? 'hide previous' : `+${previous.length} previous`}
            </button>
          </li>
        ) : null}
        <AnimatePresence initial={false} mode="popLayout">
          {previousOpen ? previous.map(brick) : []}
          {extraBlocked.map((entry) => (
            <BlockedWorkerBrick
              key={`blocked:${sessionKey(entry.worker)}`}
              entry={entry}
              blobStyle={blobStyle}
              state={stateFor?.(entry.worker) ?? 'needs-input'}
              identityFor={identityFor}
              onOpen={onOpenWorker}
            />
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
});

export default CrewStrip;
