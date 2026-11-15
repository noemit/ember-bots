import type { QuestionRequest } from '../types';

export type AsyncQuestionDraft = {
  text: string;
  mutation?: NonNullable<QuestionRequest['mutation']>;
  failed?: boolean;
  accepted?: string;
  adding?: boolean;
};
const empty: AsyncQuestionDraft = Object.freeze({ text: '' });

/** One question can move into history or appear in several supervisory panes while a request is
 * in flight. All those rows observe one draft. A late response may settle only its own mutation,
 * never erase text the human has already started for the next context message. */
export const createQuestionDraftStore = () => {
  const values = new Map<string, AsyncQuestionDraft>();
  const listeners = new Map<string, Set<() => void>>();
  const get = (key: string) => values.get(key) ?? empty;
  const put = (key: string, value?: AsyncQuestionDraft) => {
    if (value) values.set(key, value); else values.delete(key);
    listeners.get(key)?.forEach(listener => listener());
  };
  return {
    get, put,
    subscribe(key: string, listener: () => void) {
      const set = listeners.get(key) ?? new Set<() => void>();
      set.add(listener); listeners.set(key, set);
      return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
    },
    settle(key: string, requestId: string, value?: AsyncQuestionDraft) {
      if (get(key).mutation?.requestId !== requestId) return false;
      put(key, value); return true;
    },
  };
};
export const questionDrafts = createQuestionDraftStore();
