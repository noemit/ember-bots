/**
 * What a transcript's fetch state should *say*, and how alarmed it should be.
 *
 * `MessagesStatus` is a three-value type (`'loading' | 'error' | 'ready'`), and the transcript used
 * to render the middle one as a destructive alert: "Couldn't reach this session — retrying…". That
 * conflates two different situations:
 *
 * - a fetch that failed but that Ember is *actively going to retry* (a background repair, a tail
 *   read that lost a race, the first request of a launch that beat Hearth's own boot) — a waiting
 *   state, and one the user cannot act on;
 * - a fetch that failed and nothing is going to fix on its own (an explicit Refresh the user asked
 *   for, which already ran its full read and gave up) — a real failure, which deserves red and a
 *   retry button.
 *
 * Red means "something is wrong and won't fix itself". Anything Ember retries by itself was never a
 * failure the user could act on, so this module separates the two by *why* the fetch failed
 * (`TranscriptFailureSource`), not by how many times. Everything here is pure, so the wording and the
 * tone are pinned by tests instead of by squinting at a cold start.
 */
import type { InstanceStatus, MessagesStatus } from '../types';

/**
 * Which code path recorded the failure.
 *
 * Only `'reload'` — an explicit, user-initiated Refresh whose full read already ran and gave up — is
 * a settled failure. Everything else is retried by construction: the transcript poll (every 20s
 * while a column is streaming, 60s otherwise), an event hint, or the next switch-in read.
 */
export type TranscriptFailureSource =
  /** The user pressed Refresh: the full read ran and was rejected. Settled. */
  | 'reload'
  /** A background repair the poller will run again. Transient. */
  | 'poll'
  /** A tail read; the next poll retries it and a full repair backs it up. Transient. */
  | 'tail'
  /** The first read of a session coming on screen; the poll retries it. Transient. */
  | 'initial';

/** The commit path's view of a transcript: its status plus why, when the status is `'error'`. */
export type TranscriptState = {
  status: MessagesStatus;
  failure?: TranscriptFailureSource;
  /**
   * True once a full read has landed, so the rendered window is known to sit on the whole
   * transcript rather than only a tail. A tail read commits as 'ready', which is why the status
   * alone cannot answer this.
   */
  historyComplete?: boolean;
};

export type TranscriptNotice =
  /** Render the transcript (or its skeleton rows, when the status is still `'loading'`). */
  | { kind: 'none' }
  /** Waiting on a fetch Ember retries on its own: neutral wording, never destructive. */
  | { kind: 'waiting'; text: string }
  /** A settled failure: destructive styling plus a retry the user can press. */
  | { kind: 'failed'; text: string };

const NONE: TranscriptNotice = { kind: 'none' };

export type TranscriptNoticeInput = {
  state: TranscriptState;
  /** The transcript has no messages yet, so the empty pane is showing and can carry the wording. */
  messagesEmpty: boolean;
  /** The instance record's status, when one is known. */
  instanceStatus?: InstanceStatus;
  /** The instance's display label, for naming the Hearth that isn't answering. */
  instanceLabel?: string;
};

export const RETRY_HINT = 'Retrying on its own.';

/** A Hearth that isn't answering yet, named when we know its label. */
const label = (instanceLabel?: string): string => instanceLabel ?? 'ember-harness';

/**
 * `'error'` with no recorded source is the historical shape (a status of `'error'` was only ever
 * set by the reload path), so it counts as settled rather than being silently swallowed.
 */
export const isSettledFailure = (state: TranscriptState): boolean =>
  state.status === 'error' && (state.failure === undefined || state.failure === 'reload');

/**
 * The transcript's fetch state as something the UI can render honestly.
 *
 * 1. `'ready'` / `'loading'` → nothing to say; the skeleton rows already read as "fetching".
 * 2. A transcript that already has messages → nothing to say, whatever failed. The messages are
 *    still perfectly readable and the header's Refresh button is right there; a red bar over content
 *    the user is reading is exactly what made startup look broken.
 * 3. An empty pane + a transient failure → `'waiting'`. If the instance is not up yet, say *that*:
 *    on a cold boot Ember routinely asks before Hearth has bound its port, and "still starting up"
 *    is a different sentence from "this session is broken".
 * 4. An empty pane + a settled failure → `'failed'`, with the retry affordance.
 */
export const transcriptNotice = ({
  state,
  messagesEmpty,
  instanceStatus,
  instanceLabel,
}: TranscriptNoticeInput): TranscriptNotice => {
  if (state.status === 'ready' || state.status === 'loading') return NONE;
  if (!messagesEmpty) return NONE;
  // "Not up yet" is a positive claim about the instance, so it needs a status that says so. An
  // unknown status must not be read as unreachability: it would blame Hearth for a failure that may
  // be about this session.
  const notUpYet = instanceStatus === 'unreachable' || instanceStatus === 'checking';
  if (isSettledFailure(state)) {
    // Copy is the product here. "Couldn't load this session" is a dead end: it says what failed and
    // nothing else — not who, not why, not what to do. A settled failure is the one state the reader
    // can act on, so it names the host that did not answer and points at the retry that is right
    // there in the header.
    return {
      kind: 'failed',
      text: notUpYet
        ? `${label(instanceLabel)} didn't answer. It may be asleep or off the network — try again once it's back.`
        : "This session wouldn't load. Retrying usually fixes it — the Refresh button is above.",
    };
  }
  // A host Ember already knows is unreachable is not "starting up": that was written for a cold
  // boot that asked before Hearth had bound its port. Saying it now, while the reader is looking at
  // an empty pane they may have opened from a last-known list, would blame the session's own load
  // for an outage. It names the host, says why the pane is empty, and says what Ember is doing.
  if (instanceStatus === 'unreachable') {
    return {
      kind: 'waiting',
      text: `${label(instanceLabel)} isn't answering, so this conversation can't be read right now. It may be asleep or off the network, and Ember keeps retrying.`,
    };
  }
  return {
    kind: 'waiting',
    text: notUpYet
      ? `${label(instanceLabel)} is still starting up — waiting for it to answer…`
      : `Haven't loaded this session yet. ${RETRY_HINT}`,
  };
};

/** The inputs the startup line is derived from; see `startupNotice`. */
export type StartupNoticeInput = {
  /** The window's bootstrap (settings read + first instance probe) has not finished yet. */
  bootstrapping: boolean;
  /** Instances that are ready but have not produced a session list yet. */
  waitingForSessions: number;
  /** Instances that are configured but not connected. */
  unreachable: number;
  /** How many sessions are already listed, so the line can be specific. */
  sessionCount: number;
};

/**
 * The honest one-liner for "Ember is still coming up", or null when it is not.
 *
 * This exists because the skeleton rows were the *only* startup signal and they read as data loss.
 * A single neutral line that names what is happening ("Hearth is starting", "loading your sessions")
 * costs nothing and removes the ambiguity entirely. It is deliberately not an alert: nothing here is
 * wrong.
 */
export const startupNotice = ({
  bootstrapping,
  waitingForSessions,
  unreachable,
  sessionCount,
}: StartupNoticeInput): string | null => {
  if (waitingForSessions > 0) {
    return sessionCount > 0
      ? `Loading your sessions — ${sessionCount} so far…`
      : 'Connecting to ember-harness and loading your sessions…';
  }
  if (bootstrapping && sessionCount === 0) return 'Starting up…';
  if (unreachable > 0) {
    return unreachable === 1
      ? 'ember-harness is not answering yet — still trying.'
      : `${unreachable} ember-harness instances are not answering yet — still trying.`;
  }
  return null;
};
