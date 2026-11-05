/**
 * Why a new session could not be started, said in a sentence someone can act on.
 *
 * Creating a session is the one request whose failure is genuinely ambiguous: `POST /conversations`
 * answers with the new id, so a socket that dies mid-answer may have created the conversation anyway.
 * That is a different fact from "the host refused" and from "the host never answered", and the three
 * need three different stories — retrying a create that already happened is how a rail fills up with
 * empty sessions.
 *
 * So the classification is pure and pinned by tests, and each kind's sentence names the instance (the
 * reader has more than one), says what they can conclude, and points at a next step that is already on
 * screen: Try again, the folder picker below, or the rail.
 *
 * `src/api.ts` throws an error carrying a numeric `status` (0 for a transport failure). This module
 * duck-types it rather than importing it, so the copy can be tested without a bridge and the api layer
 * stays free to reshape its error class.
 */

/** What a failed create tells us. `status` is 0 for a transport failure. */
export type SessionCreateFailure = {
  kind: 'refused' | 'host-error' | 'unreachable' | 'ambiguous' | 'unknown';
  /** The host's own sentence, when it gave one. */
  detail?: string;
};

/** Hearth's own words for a folder that is not on the host; the spelling has varied. */
const MISSING_FOLDER = /folder\s+(does not|doesn't)\s+exist/i;

/** A transport failure that stopped *mid-request*: the create may or may not have happened. */
const AMBIGUOUS_DETAIL = /timed out|partway through|lost its connection/i;

/**
 * How much of the host's sentence is quoted. Long enough for a real reason ("the workspace is
 * read-only: /work/x is owned by another user"), short enough that it cannot become the whole pane.
 */
const DETAIL_LIMIT = 160;

/**
 * The host's sentence, made safe to sit inside ours.
 *
 * It is quoted, not reprinted: the first line only (a stack or a JSON envelope after a newline is not
 * a reason a person can use), a leading `Error:` dropped because we already say who failed, whitespace
 * flattened so it stays one line, trailing punctuation removed so we can add our own full stop, and a
 * length cap with an ellipsis.
 */
const quotedDetail = (detail: string): string => {
  const firstLine = detail.split(/\r?\n/, 1)[0] ?? '';
  const flattened = firstLine
    .replace(/^\s*error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '');
  return flattened.length > DETAIL_LIMIT
    ? `${flattened.slice(0, DETAIL_LIMIT).trimEnd()}…`
    : flattened;
};

const messageOf = (error: unknown): string | undefined => {
  if (typeof error === 'string') return error.trim() || undefined;
  if (!error || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message.trim() : undefined;
};

const statusOf = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
};

/**
 * Classify a failed create.
 *
 * A 4xx is the host refusing something it understood (the folder, the model, the instructions) and it
 * usually says which; a 5xx is the host failing at its own job, which is worth another try unchanged.
 * Status 0 is the transport: "timed out" or "lost its connection" partway through leaves the create
 * in doubt, while anything else means we never reached it. No status at all is a bug or a wire we do
 * not know, and it gets the plainest sentence rather than the host's raw text.
 */
export const sessionCreateFailureOf = (error: unknown): SessionCreateFailure => {
  const detail = messageOf(error);
  const status = statusOf(error);
  if (status === undefined) return { kind: 'unknown', detail };
  if (status === 0) {
    return {
      kind: detail && AMBIGUOUS_DETAIL.test(detail) ? 'ambiguous' : 'unreachable',
      detail,
    };
  }
  if (status >= 500) return { kind: 'host-error', detail };
  if (status >= 400) return { kind: 'refused', detail };
  // A 2xx or 3xx on a call we were waiting on does not describe a failure; say the plain thing.
  return { kind: 'unknown', detail };
};

/**
 * The sentence the draft pane shows over its failed bubble.
 *
 * Every branch ends with something to do next. `directory` is the folder the attempt was sent with,
 * because the most common refusal by far is that folder: naming it saves the person checking which
 * one they picked, and the picker is directly below the bubble.
 */
export const newSessionFailureText = ({
  failure,
  instanceLabel,
  directory,
}: {
  failure: SessionCreateFailure;
  instanceLabel: string;
  directory: string;
}): string => {
  // A missing label is the only case where the actor would go unnamed; "that host" still says whose
  // fault it is.
  const label = instanceLabel.trim() || 'That host';
  const folder = directory.trim();
  const detail = failure.detail ? quotedDetail(failure.detail) : '';

  switch (failure.kind) {
    case 'refused':
      if (failure.detail && MISSING_FOLDER.test(failure.detail)) {
        return folder
          ? `${label} didn't start this session: the folder ${folder} doesn't exist. Pick another folder below, then try again.`
          : `${label} didn't start this session: that folder doesn't exist. Pick another folder below, then try again.`;
      }
      return detail
        ? `${label} didn't start this session: ${detail}. Try again.`
        : `${label} didn't start this session. Try again.`;
    case 'host-error':
      return detail
        ? `${label} couldn't start this session: ${detail}. Try again.`
        : `${label} couldn't start this session. Try again in a moment.`;
    case 'unreachable':
      return `${label} isn't answering, so this session wasn't started. Try again once it's back.`;
    case 'ambiguous':
      return `${label} stopped answering partway through, so it may have started this session anyway. Check the rail before you try again.`;
    default:
      // An unclassified failure has no sentence worth quoting — it is as likely to be "Failed to
      // fetch" as a stack — so the pane says what it knows and offers the button it has.
      return `${label} didn't start this session. Try again.`;
  }
};
