/**
 * The per-session activity status line: a one-line, transient answer to "should I expect more from
 * this chat?". Pure, so the transcript can render it without owning any derivation and it stays
 * testable. Nothing here is persisted or logged; the status is recomputed from state Ember already
 * holds (ball state, the turn-live predicate, pending prompts, and the leader's crew).
 *
 * Precedence is working > needs reply > unknown > waiting on crew, then `null` (render nothing).
 * `working` is the same condition the transcript's live activity line already renders in more
 * detail, so the transcript suppresses it; the crew wait is the state that used to look idle and is
 * the one this line exists for.
 *
 * `unknown` is a first-class answer: when the host has not reported a status, the session is *not*
 * idle — it may be mid-turn — and the line says so rather than leaving the column looking asleep.
 */
import { workerStateLabel } from './crew';
import type { BallState, Session } from '../types';

export type SessionStatusKind = 'working' | 'stalled' | 'waiting-crew' | 'needs-reply' | 'unknown';

export type SessionStatus = {
  kind: SessionStatusKind;
  /** One line, already pluralised, ending in an ellipsis because the state is still open. */
  text: string;
};

export type SessionStatusInput = {
  /** Coarse ball state from the instance's status poll. */
  state: BallState;
  /** The turn is live (streaming, thinking or running a tool), from `isTurnLive`. */
  busy?: boolean;
  /** An optimistic send has not been echoed yet. */
  sending?: boolean;
  /** A leader's direct crew workers; empty or absent for everyone else. */
  workers?: readonly Session[];
  /** Their ball states, from the instance status poll. */
  workerStateFor?: (worker: Session) => BallState;
  /** The session's own pending prompt, if any. */
  pendingPrompt?: 'permission' | 'question' | null;
  /**
   * The prompt card already sits at the tail of the transcript, which says the same thing far more
   * clearly. Set this whenever a pending prompt is actually rendered.
   */
  promptCardVisible?: boolean;
  /** The instance's label, so an unanswered status can name which host has not replied. */
  instanceLabel?: string | null;
  /** When the live turn last produced new content. Absent means nothing to compare against. */
  quietSince?: number;
  /** Now, supplied by the caller so this stays pure and testable. */
  now?: number;
};

/**
 * How long a live turn may produce nothing before the UI says so: five minutes.
 *
 * Long reasoning legitimately looks like this — a model can think for minutes before its first
 * token lands, and every one of those turns is healthy. The old 90 seconds accused them constantly,
 * so the line fired during ordinary work and stopped meaning anything. At this scale waiting is the
 * normal case rather than a warning: below it "still thinking" and "wedged" are genuinely
 * indistinguishable, and inventing a distinction would be worse than waiting.
 */
export const STALL_AFTER_MS = 5 * 60_000;

/** Workers that are still in flight: anything but a resting (idle or already-reported) worker. */
const inFlight = (worker: Session, workerStateFor?: (worker: Session) => BallState): boolean => {
  const status = workerStateLabel(worker, {
    state: workerStateFor?.(worker) ?? (worker.needsInput ? 'needs-input' : 'unknown'),
  });
  return status !== 'idle' && status !== 'reported';
};

export const deriveSessionStatus = (input: SessionStatusInput): SessionStatus | null => {
  const {
    state,
    busy,
    sending,
    instanceLabel,
    workers,
    workerStateFor,
    pendingPrompt,
    promptCardVisible,
    quietSince,
    now,
  } = input;

  // A running turn beats everything: this session is the one producing output.
  const live = busy === true || sending === true || state === 'active';
  if (live) {
    // Silence is the only signal available: a turn that has produced nothing for a long time looks
    // exactly like one that is thinking hard, and no client can tell them apart. Say that plainly
    // and point at Stop, rather than leaving the reader to guess whether it is working.
    const quietFor = quietSince === undefined || now === undefined ? 0 : now - quietSince;
    if (quietFor >= STALL_AFTER_MS) {
      const minutes = Math.floor(quietFor / 60_000);
      // Past the first minute the seconds stop mattering — the threshold is measured in minutes, so
      // "5m" answers "how long has this been quiet?" and "5m 0s" just reads like a stopped watch.
      // Under a minute (only reachable if the threshold moves again) the seconds are all there is.
      const seconds = Math.round((quietFor % 60_000) / 1000);
      const elapsed = minutes >= 1 ? `${minutes}m` : `${seconds}s`;
      return {
        kind: 'stalled',
        text: `No new output for ${elapsed}. It may still be thinking, or the run may be stuck — Stop is below.`,
      };
    }
    return { kind: 'working', text: 'Working…' };
  }

  // Only when the card isn't already in the transcript, so the signal isn't doubled.
  if (pendingPrompt && promptCardVisible !== true) {
    return { kind: 'needs-reply', text: 'Waiting for your reply…' };
  }

  // No answer from the host. Saying nothing is what made this look idle; saying "idle" would be a
  // guess in the one direction that loses work (the user sends into a turn they cannot see).
  if (state === 'unknown') {
    const actor = instanceLabel?.trim() || 'The host';
    return {
      kind: 'unknown',
      text: `${actor} hasn't answered, so this session's status is unknown — you can still send.`,
    };
  }

  // Idle here but busy below: the leader will produce more once the crew reports, even though a
  // worker that is itself waiting on input is not "working". It is still an open branch, so it
  // counts toward the wait.
  const waiting = (workers ?? []).filter((worker) => inFlight(worker, workerStateFor));
  if (waiting.length > 0) {
    const plural = waiting.length === 1 ? 'worker' : 'workers';
    // A worker whose own host is not answering is still an open branch, but the leader is not
    // "waiting on" it in any useful sense — say what is actually missing.
    const unknown = waiting.filter(
      (worker) => workerStateLabel(worker, { state: workerStateFor?.(worker) ?? (worker.needsInput ? 'needs-input' : 'unknown') }) === 'unknown'
    ).length;
    if (unknown === waiting.length) {
      return {
        kind: 'waiting-crew',
        text: `${waiting.length} ${plural} whose host hasn't answered — ${
          waiting.length === 1 ? 'its status is' : 'their statuses are'
        } unknown…`,
      };
    }
    return {
      kind: 'waiting-crew',
      text: `Waiting on ${waiting.length} ${plural}…`,
    };
  }

  return null;
};
