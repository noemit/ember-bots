import type { QuestionAnswers, QuestionRequest, Session } from '../types';

export const isAsyncQuestion = (request: QuestionRequest) => request.mode === 'async';
/** Supervisory ancestry comes from the questions endpoint, not a paged session list. */
export const questionsForSupervisor = (session: Session, requests: readonly QuestionRequest[]) =>
  requests.filter((request) => isAsyncQuestion(request) && request.instanceId === session.instanceId &&
    (request.sessionId === session.id || request.ancestry?.some((ancestor) => String(ancestor.conversationId) === session.id)));

export const questionStatusLabel = (request: QuestionRequest): string => {
  if (request.status === 'withdrawn') return 'Answer or question withdrawn';
  if (request.status === 'cancelled') return 'Question cancelled';
  if (request.status === 'superseded') return 'Replaced by a newer question';
  if (request.status !== 'answered') return 'Waiting for your answer · bot can continue';
  switch (request.delivery?.status) {
    case 'held': return 'Sent · held on the host';
    case 'admitted': return request.delivery.placement === 'placed' ? 'Delivered to the chat · not yet confirmed seen' : 'Answer admitted · not yet confirmed seen';
    case 'placed': return 'Answer placed · not yet confirmed seen';
    case 'seen': return 'Answer seen by the bot';
    case 'executed': return 'Bot continued with this answer';
    default: return 'Sent · delivery not yet confirmed';
  }
};

/** Ancestry is immediate parent first. The child just before this root is its group. */
export const questionSupervisor = (request: QuestionRequest, current: string) => {
  const chain = request.ancestry ?? [];
  const index = chain.findIndex((item) => String(item.conversationId) === current);
  return index > 0 ? chain[index - 1].title || chain[index - 1].conversationId : request.sessionId === current ? 'This conversation' : 'Direct threads';
};

/** Context records are independent deliveries but belong beneath their original question. */
export const questionFollowups = (parent: QuestionRequest, requests: readonly QuestionRequest[]) =>
  requests.filter(item => item.replyTo && item.instanceId === parent.instanceId && item.sessionId === parent.sessionId &&
    parent.id === `${item.sessionId}:${item.replyTo}`)
    .sort((a, b) => (a.contextSequence ?? 0) - (b.contextSequence ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0));

/** Only host-recorded provenance may navigate to a message. Free-text source is a description. */
export const questionSourceMessage = (request: QuestionRequest): string | undefined => {
  const source = request.origin?.sourceMessageId;
  return request.origin?.conversationId === request.sessionId && source && /^e[1-9][0-9]*$/.test(source) ? source : undefined;
};

/** A transport refusal is not evidence of loss. Recover only from an exact, scoped canonical
 * receipt, never matching answer prose or timestamps. Additional context has its own receipt. */
export const questionMutationConfirmed = (request: QuestionRequest, answers: QuestionAnswers | null, current: readonly QuestionRequest[]): boolean => {
  const mutation = request.mutation;
  if (!mutation) return false;
  const action = mutation.action ?? 'answer';
  const candidates = action === 'context' ? questionFollowups(request, current) : current.filter(item => item.instanceId === request.instanceId && item.sessionId === request.sessionId && item.id === request.id);
  if (action === 'withdraw') return candidates.some(item => item.status === 'withdrawn' && item.mutation?.action === 'withdraw' && item.mutation.requestId === mutation.requestId && item.mutation.revision === mutation.revision);
  const answer = (answers?.[0] ?? []).join('\n');
  return candidates.some(item => item.receipt?.requestId === mutation.requestId && item.receipt.revision === mutation.revision && item.receipt.answer === answer);
};
