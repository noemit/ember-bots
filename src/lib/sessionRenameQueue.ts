/**
 * Choosing which conversations to rename, and what to call them.
 *
 * The rules live here rather than inside `App.tsx` so they can be read and tested without a running
 * app: which sessions are eligible, what "the first reply" means in a transcript, and — the one that
 * matters — when a rename must be refused.
 */

import type { ChatMessage } from '../types';
import { upgradedName, type UpgradeInput } from './sessionRename';

/** A conversation that might be renamed. */
export type RenameCandidate = {
  /** `sessionKey` of the conversation. */
  key: string;
  /** Whether this key is still marked provisional by the caller's own bookkeeping. */
  provisional: boolean;
  /** The human's first message, which the current name was derived from. */
  request: string;
  directory?: string;
  project?: string;
};

/**
 * The agent's first reply in a transcript, or null when it has not spoken.
 *
 * "First reply" is the first assistant message with text in it. Tool calls are skipped rather than
 * counted: a turn that opens with three reads and no prose has said nothing a reader would call an
 * answer, and a name derived from `read` would be worse than the provisional one.
 */
export const firstReplyText = (messages: readonly ChatMessage[]): string | null => {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    // `text` is the message's own concatenated text parts, so a reply split across several parts
    // reads as one answer and a turn that was only tool calls is empty here.
    const trimmed = (message.text ?? '').trim();
    if (trimmed) return trimmed;
  }
  return null;
};

/** Whether a session is eligible at all: it must still be marked provisional. */
export const isRenamable = (candidate: RenameCandidate): boolean => candidate.provisional;

/**
 * The title to give a conversation, or null to leave it alone.
 *
 * Everything that could make a rename wrong is decided here, so a caller only has to ask once:
 * a human rename is refused (it is no longer marked provisional), a missing or short reply is
 * refused, and a request that already named its own subject is refused. Only the case this feature
 * exists for — a provisional name from an intent-only request, now with a reply that names
 * something — returns a string.
 */
export const renameFor = (
  candidate: RenameCandidate,
  reply: string | null,
  taken: readonly string[]
): string | null => {
  if (!isRenamable(candidate)) return null;
  if (!reply) return null;
  const input: UpgradeInput = {
    request: candidate.request,
    reply,
    directory: candidate.directory,
    project: candidate.project,
    taken,
  };
  return upgradedName(input);
};
