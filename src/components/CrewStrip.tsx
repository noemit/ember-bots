import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { springTransition } from '@/lib/animation';
import Blob from '../blob/Blob';
import { blobColor } from '../blob/color';
import { moodFrom } from '../blob/mood';
import { seedIdentity } from '../blob/seed';
import { sessionKey } from '../types';
import {
  brickStatusSignal,
  leaderBrickStyle,
  leaderBrickWash,
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
  /** Open a worker: the lead renders it as a transient column. */
  onOpenWorker: (session: Session) => void;
  /** Resolve a promoted worker's peer session (same instance) so the brick links to it. */
  peerFor?: (worker: Session) => Session | null;
  /** Blob renderer style, from settings (needed to draw each worker's blob). */
  blobStyle: BlobStyle;
  /** Coarse ball state per worker, from the instance's status poll; missing reads as idle. */
  stateFor?: (session: Session) => BallState;
  /** Server-side auto-accept (YOLO) per worker, shown as the same YOLO chip the composer uses. */
  autoAcceptFor?: (session: Session) => boolean;
  /** Toggle a worker's auto-accept; omit to render the chip read-only. */
  onToggleYolo?: (session: Session, enabled: boolean) => void;
  /**
   * Workers **below** this leader's direct crew that are blocked on the human, at any depth, from
   * `blockedWorkersUnder` in `lib/crew`. They ride alongside the direct bricks; each one opens the
   * conversation that is actually waiting.
   */
  nestedBlocked?: BlockedWorker[];
  /**
   * The blob identity the rail resolves for a session (project colour, avatar override, scheduled
   * binding). Without it a brick derives one from the key alone and draws a different blob at 16px
   * than the column draws at full size for the same worker.
   */
  identityFor?: (session: Session) => AvatarIdentity | undefined;
  /**
   * The **leader's** own identity, used for one thing only: the colour family of the bricks. It
   * washes each brick's surface and tints its edge (`blobColor` → `leaderBrickStyle`), so a crew
   * reads as its leader's family while every worker's *blob* still draws the identity its column
   * draws — the two must never disagree (see the comment in `WorkerBrick`).
   *
   * Absent, the bricks stay untinted: a standalone strip should not invent a colour it was not
   * given.
   */
  leaderIdentity?: AvatarIdentity;
  /** The leader's title, for the strip's accessible name and the collapsed pill's tooltip. */
  leaderTitle?: string;
};

/**
 * The brick's own surface, by tone. The two loud states take the surface, so the leader's wash is
 * kept off their edge — a warning tinted in the leader's colour reads as decoration.
 */
const BRICK_SURFACE: Record<CrewBrickTone, string> = {
  // No edges anywhere: the status is the tint, the dot and (for "needs input") the word.
  attention: 'bg-highlight/15',
  failed: 'bg-destructive/15',
  unknown: 'bg-muted/40',
  active: '',
  done: '',
  quiet: '',
};

/** Tones whose edge is the status's own; the rest let the leader's colour tint the border. */
const OWNS_EDGE: Record<CrewBrickTone, boolean> = {
  attention: true,
  failed: true,
  unknown: false,
  active: false,
  done: false,
  quiet: false,
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

/**
 * The shared brick shell: one wrapped line, blob + truncated title + signal. The width cap is per
 * tone (`BRICK_MAX_W`) because a brick that prints a word has to fit that word *and* a readable
 * title — six characters of "Migr…" beside "needs input" is worse than one wider brick.
 */
const BRICK_CLASS =
  // `@container` on the brick itself: the YOLO chip's word collapses against the room *this* chip
  // has, not the window's, which is the only measure that means anything inside a wrapped strip.
  'group/brick @container inline-flex min-w-0 items-center gap-1 rounded-full bg-muted/70 px-1.5 py-1 text-[11px] text-foreground';

/** A brick stays compact; the loud ones earn the room their word needs. */
const BRICK_MAX_W: Record<CrewBrickTone, string> = {
  attention: 'max-w-[240px]',
  failed: 'max-w-[170px]',
  unknown: 'max-w-[170px]',
  active: 'max-w-[170px]',
  done: 'max-w-[170px]',
  quiet: 'max-w-[170px]',
};

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
  leaderColor,
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
  /** The leader's blob colour, or undefined to leave the brick untinted. */
  leaderColor?: string;
  onOpen: (session: Session) => void;
  onToggleYolo?: (session: Session, enabled: boolean) => void;
  identityFor?: (session: Session) => AvatarIdentity | undefined;
}) {
  // A promoted brick is a link to the peer fork; without the peer loaded it still opens the worker.
  const promoted = worker.promotedTo !== undefined;
  const linkTarget = peer ?? worker;
  // Ask the caller for the identity its column uses; derive one only when it has none to give. The
  // brick used to always seed from the key, so any worker with a project colour or an avatar
  // override wore one blob here and a different one the moment it opened as a column. The brick's
  // tint comes from the *leader* precisely so this stays true: nothing here recolours a blob.
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
  const hint = promoted ? `Open the peer for ${title}` : `Open ${title}`;
  // The leader's wash, computed from primitives so the memo above isn't defeated by a fresh object.
  const tint = React.useMemo(() => {
    if (!leaderColor) return undefined;
    if (signal.tone === 'failed') return undefined;
    return OWNS_EDGE[signal.tone]
      ? { backgroundColor: leaderBrickWash(leaderColor) }
      : leaderBrickStyle(leaderColor);
  }, [leaderColor, signal.tone]);

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={springTransition}
      data-crew-brick=""
      data-worker-status={status}
      className={cn(BRICK_CLASS, BRICK_MAX_W[signal.tone], BRICK_SURFACE[signal.tone])}
      style={tint}
    >
      <button
        type="button"
        onClick={() => onOpen(linkTarget)}
        title={`${hint} — ${signal.word}`}
        aria-label={title}
        aria-describedby={statusId}
        className="flex min-w-0 items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Blob
          style={blobStyle}
          seed={sessionKey(linkTarget)}
          identity={identity}
          size={16}
          mood={mood}
          interactive={false}
        />
        <span className="min-w-0 truncate">{title}</span>
        {/* Exactly one node carries the status word, and it is the one `aria-describedby` points at:
            the word itself when the state prints it, a hidden word beside the dot when it does not.
            Two carriers would read "needs input" twice — to a screen reader and to any text query. */}
        {signal.showWord ? (
          <span
            id={statusId}
            className="flex-none rounded-sm bg-highlight px-1 text-[9.5px] leading-4 font-semibold text-highlight-foreground"
          >
            {signal.word}
          </span>
        ) : (
          <>
            <span aria-hidden="true" className={cn('size-1.5 flex-none rounded-full', BRICK_DOT[signal.tone])} />
            <span id={statusId} className="sr-only">
              {signal.word}
            </span>
          </>
        )}
      </button>
      {promoted ? (
        <span
          className="flex-none rounded-sm border border-highlight/50 px-1 text-[9.5px] leading-4 font-semibold text-highlight uppercase"
          title="This worker has been promoted to an addressable peer"
        >
          peer
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
                className="h-5 flex-none items-center gap-0.5 rounded-sm bg-warning/15 px-1 text-[9.5px] leading-4 font-semibold tracking-wide text-warning uppercase hover:bg-warning/25"
              >
                <ShieldCheck className="size-2.5 flex-none" aria-hidden="true" />
                <span className="hidden @[420px]:inline">Yolo</span>
              </Button>
            ) : (
              <span
                className="flex flex-none items-center gap-0.5 rounded-sm border border-warning/50 px-1 text-[9.5px] leading-4 font-semibold text-warning uppercase"
                title="YOLO mode is on for this worker"
              >
                <ShieldCheck className="size-2.5 flex-none" aria-hidden="true" />
                <span className="hidden @[420px]:inline">Yolo</span>
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
              className="h-5 flex-none items-center gap-0.5 rounded-sm px-1 text-[9.5px] leading-4 font-semibold tracking-wide text-muted-foreground uppercase opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/brick:opacity-100"
            >
              <ShieldCheck className="size-2.5 flex-none" aria-hidden="true" />
              <span className="hidden @[420px]:inline">Yolo</span>
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
 * It keeps its highlight surface rather than the leader's wash — it is the loudest thing in the
 * strip by design — and announces `nested` rows with their depth rather than a bubble, so it reads
 * as "inside my crew" without imitating the queue card.
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
      className={cn(BRICK_CLASS, BRICK_MAX_W.attention, 'bg-highlight/15')}
    >
      <button
        type="button"
        onClick={() => onOpen(worker)}
        title={`${nested ? `Open ${title} (crew depth ${entry.depth})` : `Open ${title}`} — needs input`}
        aria-label={`${title} needs input — open the conversation to answer`}
        className="flex min-w-0 items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Blob
          style={blobStyle}
          seed={sessionKey(worker)}
          identity={identity}
          size={16}
          mood={mood}
          interactive={false}
        />
        <span className="min-w-0 truncate">{title}</span>
        {nested ? (
          <span
            className="flex-none text-[9.5px] leading-4 text-muted-foreground tabular-nums"
            title={`${entry.depth} levels below this agent`}
          >
            {`›${entry.depth}`}
          </span>
        ) : null}
        <span className="flex-none rounded-sm bg-highlight px-1 text-[9.5px] leading-4 font-semibold text-highlight-foreground">
          needs input
        </span>
      </button>
    </motion.li>
  );
});

/**
 * The crew strip: the only place a leader's workers appear (they are hidden from the rail). A
 * sibling of the queue/notes cards above the composer; one **brick** per worker — its blob, its
 * title and a compact status signal — wrapping into a few short lines instead of a scrolling
 * column of full-width rows. Whole bricks are buttons: clicking one opens that worker as a
 * transient column. Renders nothing when the leader has no workers.
 *
 * The bricks carry the leader's colour (`leaderIdentity`) as a wash and an edge tint, which is what
 * makes a crew read as one family; each brick's blob is untouched, so it still matches the blob the
 * worker wears when opened. Without a leader identity the bricks stay neutral.
 */
const CrewStrip = React.memo(function CrewStrip({
  workers,
  onOpenWorker,
  peerFor,
  blobStyle,
  stateFor,
  autoAcceptFor,
  onToggleYolo,
  nestedBlocked = [],
  identityFor,
  leaderIdentity,
  leaderTitle,
}: Props) {
  // Live work in the chips; finished workers behind one chip instead of lengthening the row.
  const { live, previous } = splitCrew(workers, stateFor);
  const [previousOpen, setPreviousOpen] = React.useState(false);
  // Resolved once for the whole strip: `blobColor` consumes the seed RNG, and a string keeps the
  // memoized bricks comparable (a fresh identity object per render would re-render all of them).
  const leaderColor = React.useMemo(
    () => (leaderIdentity ? blobColor(blobStyle, leaderIdentity) : undefined),
    [blobStyle, leaderIdentity]
  );
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
        auto={autoAcceptFor?.(worker) === true}
        peer={worker.promotedTo !== undefined ? peerFor?.(worker) ?? null : null}
        leaderColor={leaderColor}
        onOpen={onOpenWorker}
        onToggleYolo={onToggleYolo}
        identityFor={identityFor}
      />
    );
  };

  return (
    /* No card, and no edges on the chips: a border around a bordered chip is what read as a chip
       inside a card. The tint still says which leader this crew belongs to, and the container owes
       nothing but the group's accessible name — the shelf above owns opening and folding. */
    <div
      role="group"
      aria-label={leaderTitle ? `Crew of ${leaderTitle}` : 'Crew'}
      className="group/strip flex min-w-0 flex-wrap items-center gap-1"
    >
      {/* Bricks wrap: no `max-h`, no inner scroll. A crew of ten grows to three short lines, which
          is cheaper to read than a 160px window over the composer with hidden rows in it. */}
      <ul className="flex min-w-0 flex-wrap items-center gap-1">
        <AnimatePresence initial={false} mode="popLayout">
          {live.map(brick)}
        </AnimatePresence>
        {previous.length > 0 ? (
          <li className="inline-flex min-w-0">
            <button
              type="button"
              onClick={() => setPreviousOpen((open) => !open)}
              aria-expanded={previousOpen}
              title={
                previousOpen
                  ? 'Hide previous worker chats'
                  : `${previous.length} finished worker ${previous.length === 1 ? 'chat' : 'chats'}`
              }
              className="inline-flex items-center rounded-md border border-dashed px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
