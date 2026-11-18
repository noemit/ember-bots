import type { QuestionRequest } from '../types';

export type AsyncQuestionDraft = {
  text: string;
  mutation?: NonNullable<QuestionRequest['mutation']>;
  failed?: boolean;
  accepted?: string;
  adding?: boolean;
};
export type QuestionFailureRecovery = {
  message: string;
  retryAction: 'answer' | 'withdraw' | 'context' | null;
  unlockLabel: 'Cancel' | 'Edit draft' | 'Edit this draft' | 'Keep this draft as more context';
};
const empty: AsyncQuestionDraft = Object.freeze({ text: '' });

export const unlockQuestionDraft = (
  draft: AsyncQuestionDraft,
  options: { pending: boolean; sentAnswer?: string }
): AsyncQuestionDraft | undefined => {
  if (draft.mutation?.action === 'withdraw') {
    if (!draft.text && !draft.accepted && !draft.adding) return undefined;
    return {
      text: draft.text,
      ...(draft.accepted ? { accepted: draft.accepted } : {}),
      ...(draft.adding ? { adding: true } : {}),
    };
  }
  const accepted = !options.pending ? (draft.accepted ?? options.sentAnswer) : undefined;
  return {
    text: draft.text,
    adding: !options.pending,
    ...(accepted ? { accepted } : {}),
  };
};

export const questionFailureRecovery = (
  request: QuestionRequest,
  draft: AsyncQuestionDraft,
  hostLabel = 'Kiln',
  busy = false
): QuestionFailureRecovery | null => {
  if (!draft.failed || busy) return null;
  const host = hostLabel.trim() || 'Kiln';
  const action = draft.mutation?.action ?? 'answer';
  const answerConflict = Boolean(
    action === 'answer' &&
    request.status === 'answered' &&
    request.receipt &&
    request.receipt.requestId !== draft.mutation?.requestId
  );
  if (answerConflict) {
    return {
      message: `${host} already has an answer to this question. Your draft was not sent; you can keep it as more context below.`,
      retryAction: null,
      unlockLabel: 'Keep this draft as more context',
    };
  }
  if (action === 'withdraw') {
    const stillOpen = !request.status || request.status === 'pending';
    return {
      message: stillOpen
        ? `${host} did not confirm withdrawing this question, so it is still open. Use Retry to try withdrawing again, or Cancel to answer or edit instead.`
        : `${host} did not confirm withdrawing this question. Use Retry to try withdrawing again, or Cancel to dismiss this notice.`,
      retryAction: 'withdraw',
      unlockLabel: 'Cancel',
    };
  }
  const revisionChanged = (request.revision ?? 1) !== (draft.mutation?.revision ?? 1);
  const unlockLabel = action !== 'context' && request.status === 'answered'
    ? 'Keep this draft as more context'
    : revisionChanged
      ? 'Edit this draft'
      : 'Edit draft';
  const message = unlockLabel === 'Keep this draft as more context'
    ? `${host} did not confirm this change. Your text is kept here. Use Retry to send the same request again, or keep this draft as more context.`
    : `${host} did not confirm this change. Your text is kept here. Use Retry to send the same request again, or ${unlockLabel} to update it.`;
  return {
    message,
    retryAction: action === 'context' ? 'context' : 'answer',
    unlockLabel,
  };
};

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
