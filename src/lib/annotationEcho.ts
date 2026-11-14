import type { ChatMessage } from '../types';
import type { SubmissionReceipt } from '../api';

/** A receipt proves identity before the link store answers. Never make that message disappear
 * while saving its link: prefer a server echo already held, or retain the submitted bubble under
 * the host's proven identity until the transcript supplies it. Queued work stays in the queue. */
export const preserveAnnotationEcho = (
  messages: readonly ChatMessage[],
  attemptIds: readonly string[],
  receipt: SubmissionReceipt,
  submitted: ChatMessage
): ChatMessage[] => {
  const attempts = new Set(attemptIds);
  if (receipt.kind === 'queue') return messages.filter((message) => !attempts.has(message.id));
  const existing = messages.find((message) => message.id === receipt.id);
  const canonical: ChatMessage = existing ?? {
    ...submitted,
    id: receipt.id,
    parts: submitted.parts.map((part, index) => ({ ...part, id: receipt.id + '-' + index })),
    delivery: 'unconfirmed',
  };
  const result: ChatMessage[] = [];
  let placed = false;
  for (const message of messages) {
    if (message.id === receipt.id) { result.push(canonical); placed = true; }
    else if (attempts.has(message.id)) {
      // Keep its position when the server echo has not arrived yet.
      if (!existing && !placed) { result.push(canonical); placed = true; }
    } else result.push(message);
  }
  if (!placed) result.push(canonical);
  return result;
};
