import type { BallState, ChatMessage, MessagePart } from '../types';

/**
 * Whether a session's turn is still live. Drives the transcript's activity line and the composer's
 * queue-vs-send choice, so both must agree.
 *
 * `state` is authoritative — it comes from Hearth's `busy` flag and is refreshed on `run_start` and
 * `run_end` — so an unfinished last message must never override an idle verdict. An aborted turn
 * leaves its last assistant message with `stopReason: 'toolUse'` (and its tool settled to
 * `interrupted`), which is never `completed`; trusting that alone spun "thinking" forever until the
 * next message. `sending` covers the optimistic window before the server reports `active`; the
 * last-message clause only bridges a poll lag, and only while the server has not said idle.
 */
export const isTurnLive = ({
  sending,
  state,
  last,
}: {
  sending: boolean;
  state: BallState;
  last: ChatMessage | undefined;
}): boolean =>
  sending ||
  state === 'active' ||
  // The last-message bridge needs a *known* non-idle verdict to bridge from: an unanswered host says
  // nothing, and an unfinished last message is not evidence that a run is going now (a stopped turn
  // never completes its last message either).
  ((state === 'needs-input' || state === 'error') && last?.role === 'assistant' && !last.completed) ||
  // A generation Hearth is streaming into this column is direct observation, not a status guess:
  // text is arriving whatever the poll could not say. A live slot under a *known idle* verdict is the
  // stale case (a stopped run that never settled), which is why the idle check is still required.
  (state === 'unknown' && last?.live === true);

/**
 * What a part contributes to the output signature: a short, deterministic token whose value changes
 * whenever that part draws something new.
 *
 * The text a part carries is the point. `text` and `reasoning` grow in place while the model
 * streams — a single part whose own string lengthens — so a signature over the *message* text alone
 * (which `ChatMessage.text` assembles from `text` blocks only) never moves while reasoning arrives.
 * A tool is the other streaming case: its progress lands in `call.output`, and, for a `codemode`
 * script, in the nested calls it made.
 *
 * Everything here is a length or a status letter, never content: this runs on every render of a live
 * transcript, so it has to stay O(parts) concatenation and never hash or serialise a message.
 */
const partSignature = (part: MessagePart): string => {
  switch (part.type) {
    case 'text':
      return `x${part.text.length}`;
    case 'reasoning':
      return `r${part.text.length}`;
    case 'tool': {
      const call = part.call;
      const nested = call.nestedCalls;
      let nestedRunning = 0;
      if (nested) for (const entry of nested) if (entry.status === 'running') nestedRunning += 1;
      const lens = [
        call.output?.length ?? 0,
        call.error?.length ?? 0,
        call.diff?.length ?? 0,
        call.images?.length ?? 0,
        nested?.length ?? 0,
        nestedRunning,
      ];
      return `t${call.status}:${lens.join('.')}`;
    }
    case 'file':
      return 'f';
    default: {
      // A block kind this build does not know yet (a newer host's part). Nothing on it is typed, so
      // contribute its raw type name: stable across renders, cheap, and still enough for a new part
      // to register. It must never throw — an unknown part is output, not an error.
      const unknown = part as unknown as { type?: unknown };
      return `?${String(unknown.type)}`;
    }
  }
};

/**
 * A stable fingerprint of the visible output in a message, used by the transcript to tell "this
 * live turn is still producing something" from "this live turn has been silent".
 *
 * It covers every source of new output, not just the message's assembled text: the text length, the
 * part count (so a brand-new part registers even when nothing in the old ones moved), and each
 * part's own text length. Reasoning is why this exists: a model thinking for minutes lengthens one
 * `reasoning` part and changes neither `text.length` nor `parts.length`, which had the transcript
 * report "No new output for 5m, the run may be stuck" while reasoning streamed onto the screen.
 *
 * The caller decides when a turn is live at all (see `isTurnLive`) and uses its own `idle` marker
 * for "not live"; a missing message is therefore `0/0` — an empty *live* turn — not `idle`. Sharing
 * the caller's marker would hide the idle→busy edge (a run starting before its transcript has
 * loaded) and let the new run inherit the previous one's silence.
 */
export const outputSignature = (message: ChatMessage | undefined): string => {
  if (!message) return '0/0';
  const { parts } = message;
  const signature = `${message.text.length}/${parts.length}`;
  if (parts.length === 0) return signature;
  const tokens: string[] = [];
  for (const part of parts) tokens.push(partSignature(part));
  return `${signature}|${tokens.join('|')}`;
};
