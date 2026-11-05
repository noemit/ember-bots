import type { ChatMessage, MessagesStatus } from '../types';
import type { TranscriptFailureSource } from './transcriptStatus';

/** The fields a transcript commit owns. Anything else on the state belongs to another writer. */
export type TranscriptCommit = {
  messages: ChatMessage[];
  status: MessagesStatus;
  failure?: TranscriptFailureSource;
};

/**
 * Applies a commit to a transcript state without rebuilding it from three keys.
 *
 * `historyComplete` is the field that made this matter: it is written by the full read, not by the
 * commit, so a commit that returned `{ messages, status, failure }` erased it. A fully loaded
 * conversation then reverted to "earlier messages aren't loaded" on the very next append — and, when
 * the full read could not land, stayed there. Every other field a transcript grows later has the
 * same problem, so the merge is structural rather than a list of keys to remember.
 */
export const applyTranscriptCommit = <T extends TranscriptCommit>(
  current: T | undefined,
  commit: TranscriptCommit
): T => ({ ...current, ...commit }) as T;
