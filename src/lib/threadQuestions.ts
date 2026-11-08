import { sessionKey, type QuestionRequest, type Session } from '../types';

export type ThreadQuestion = { request: QuestionRequest; source: Session };

/** Identity includes the host and conversation: form ids are not globally unique. */
export const questionKey = (request: QuestionRequest): string =>
  JSON.stringify([request.instanceId, request.sessionId, request.id]);

/** Only server pending questions, never summary flags or synthetic transcript entries. */
export const questionsFromThreads = (
  descendants: readonly Session[], questions: readonly QuestionRequest[]
): ThreadQuestion[] => {
  const sources = new Map(descendants.map((source) => [sessionKey(source), source]));
  const seen = new Set<string>();
  return questions.flatMap((request) => {
    const source = sources.get(sessionKey(request));
    const key = questionKey(request);
    if (!source || seen.has(key)) return [];
    seen.add(key);
    return [{ request, source }];
  });
};
