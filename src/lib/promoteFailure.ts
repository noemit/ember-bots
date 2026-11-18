import { type SessionCreateFailure } from './newSessionFailure';

const DUPLICATE_NAME = /already registered/i;
const BUSY_CONVERSATION = /conversation is busy|wait or stop it first/i;
const NOTHING_TO_FORK = /nothing to fork/i;
const NOT_A_WORKER = /not a worker/i;
const DETAIL_LIMIT = 160;

/**
 * Sanitize a host error string so it can sit calmly inside our sentence without HTTP numbers,
 * exclamation marks, protocol words, or multiline stack output.
 */
const quotedDetail = (detail: string): string => {
  const firstLine = detail.split(/\r?\n/, 1)[0] ?? '';
  const flattened = firstLine
    .replace(/^\s*error:\s*/i, '')
    .replaceAll('!', '')
    .replace(/\b(4\d\d|5\d\d|undefined|null|status)\b/gi, '')
    .replace(/\bagents\b/gi, 'bots')
    .replace(/\bagent\b/gi, 'bot')
    .replace(/\bpeers\b/gi, 'persistent bots')
    .replace(/\bpeer\b/gi, 'persistent bot')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?,;:]+$/, '');
  return flattened.length > DETAIL_LIMIT
    ? `${flattened.slice(0, DETAIL_LIMIT).trimEnd()}…`
    : flattened;
};

/**
 * Calm, actor-named inline error copy for `PromoteWorkerDialog`.
 *
 * Every branch names the host (`instanceLabel`), says what the reader can conclude (including that
 * their typed name and description are still in the dialog), and points at a recovery action that
 * is already on screen.
 */
export const promoteFailureText = ({
  failure,
  instanceLabel,
  name,
}: {
  failure: SessionCreateFailure;
  instanceLabel?: string;
  name: string;
}): string => {
  const label = instanceLabel?.trim() || 'Kiln';
  const trimmedName = name.trim();
  const detail = failure.detail ? quotedDetail(failure.detail) : '';

  switch (failure.kind) {
    case 'refused':
      if (failure.detail && DUPLICATE_NAME.test(failure.detail)) {
        return trimmedName
          ? `${label} already has a bot named “${trimmedName}”. Choose another name above, then try Make persistent again.`
          : `${label} already has a bot with that name. Choose another name above, then try Make persistent again.`;
      }
      if (failure.detail && BUSY_CONVERSATION.test(failure.detail)) {
        return `${label} says this thread is still working, so it couldn’t copy a settled history yet. Choose Cancel to wait or use its Stop button, then reopen Promote.`;
      }
      if (failure.detail && NOTHING_TO_FORK.test(failure.detail)) {
        return `${label} doesn’t have any saved messages in this thread yet, so there is nothing to copy into a persistent bot. Choose Cancel and wait for its first reply, then try again.`;
      }
      if (failure.detail && NOT_A_WORKER.test(failure.detail)) {
        return `${label} says this session is already its own bot, so it doesn’t need to be promoted. Choose Cancel to return to it.`;
      }
      return detail
        ? `${label} didn’t make this bot persistent: ${detail}. Your description is kept above — adjust the details or try Make persistent again.`
        : `${label} didn’t make this bot persistent. Your description is kept above — check the name and try Make persistent again.`;
    case 'host-error':
      return detail
        ? `${label} couldn’t make this bot persistent: ${detail}. Your name and description are kept above — try Make persistent again in a moment.`
        : `${label} couldn’t make this bot persistent right now. Your name and description are kept above — try Make persistent again in a moment.`;
    case 'unreachable':
      return `${label} isn’t answering — it may be asleep or off the network. Your name and description are kept above; try Make persistent again once it’s back.`;
    case 'ambiguous':
      return `${label} stopped answering partway through, so it may have created the persistent bot anyway. Choose Cancel to check the rail before trying Make persistent again.`;
    default:
      return `${label} didn’t finish making this bot persistent. Your name and description are kept above — try Make persistent again.`;
  }
};
