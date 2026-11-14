/** Pure eligibility and transcript evidence selection; persistence belongs to the caller. */
import type { ChatMessage } from '../types';
import { replyIsSubstantive, upgradedName } from './sessionRename';

export type RenameCandidate = {
  key: string;
  provisional: boolean;
  /** Current host title, compared exactly with the locally persisted creation seed. */
  currentTitle?: string;
  /** Absent seeds never enroll old conversations, even when their history is readable. */
  expectedTitle?: string;
  request: string;
  directory?: string;
  project?: string;
  kind?: 'worker' | 'peer';
};

/** Internal task/crew notices are not the human's intent or the assistant's answer. */
const internalNotice = (text: string): boolean => /^\s*(?:\[(?:crew|system|internal|thread(?:-result)?)\]|<\/?(?:system|internal|system-reminder)\b)/i.test(text);

export type FirstExchangeEvidence = { request: string; reply: string };

/**
 * Requires full history from the caller. Never borrow a later exchange if the first ended with
 * only an acknowledgement. Only its last assistant entry can be the settled answer: an earlier
 * substantive commentary must not survive a final error, abort, tool step or acknowledgement.
 * Internal notices do not change that boundary. The caller also guards against an active turn.
 */
export const firstExchangeEvidence = (messages: readonly ChatMessage[]): FirstExchangeEvidence | null => {
  let request: string | undefined;
  let finalAssistant: ChatMessage | undefined;
  for (const message of messages) {
    if (internalNotice(message.text ?? '')) continue;
    if (message.role === 'user') {
      if (request !== undefined) break;
      request = message.text.trim();
      continue;
    }
    if (message.role === 'assistant' && request) finalAssistant = message;
  }
  if (!request || !finalAssistant || finalAssistant.completed !== true || finalAssistant.live ||
      finalAssistant.error || finalAssistant.aborted || finalAssistant.parts.some(part => part.type === 'tool')) return null;
  const reply = (finalAssistant.text ?? '').trim();
  return replyIsSubstantive(reply) ? { request, reply } : null;
};

/** Integration name: availability means this first exchange can be assessed once, even if no rename. */
export const firstNamingExchange = firstExchangeEvidence;

export const firstReplyText = (messages: readonly ChatMessage[]): string | null =>
  firstExchangeEvidence(messages)?.reply ?? null;

export const isRenamable = (candidate: RenameCandidate): boolean =>
  candidate.provisional && candidate.kind !== 'worker' &&
  typeof candidate.expectedTitle === 'string' && candidate.expectedTitle.length > 0 &&
  candidate.currentTitle === candidate.expectedTitle;

/** Caller consumes the provisional mark after assessing substantive evidence, even for null. */
export const renameFor = (candidate: RenameCandidate, reply: string | null, taken: readonly string[]): string | null => {
  if (!isRenamable(candidate) || !reply) return null;
  return upgradedName({ ...candidate, initialTitle: candidate.expectedTitle, reply, taken });
};
