import type { QuestionRequest, Session } from '../types';

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
    case 'held': return 'Answer saved · held on the host';
    case 'admitted': return 'Answer admitted · not yet confirmed seen';
    case 'placed': return 'Answer placed · not yet confirmed seen';
    case 'seen': return 'Answer seen by the bot';
    case 'executed': return 'Bot continued with this answer';
    default: return 'Answer saved · delivery not yet confirmed';
  }
};

/** Ancestry is immediate parent first. The child just before this root is its group. */
export const questionSupervisor = (request: QuestionRequest, current: string) => {
  const chain = request.ancestry ?? [];
  const index = chain.findIndex((item) => String(item.conversationId) === current);
  return index > 0 ? chain[index - 1].title || chain[index - 1].conversationId : request.sessionId === current ? 'This conversation' : 'Direct threads';
};
