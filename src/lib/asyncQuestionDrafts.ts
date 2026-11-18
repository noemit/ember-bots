import type { QuestionRequest } from '../types';
import { composeQuestionAnswer, formatQuestionAnswerForRequest } from './asyncQuestions';

export type AsyncQuestionDraft = {
  text: string;
  picked?: string[];
  /** Combined payload frozen at submit time so retries and receipt matching stay immutable. */
  submitted?: string;
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
const EMPTY_PICKED: readonly string[] = Object.freeze([]);

export const draftPickedChoices = (draft: AsyncQuestionDraft): readonly string[] => draft.picked ?? EMPTY_PICKED;

export const draftAnswerPayload = (request: QuestionRequest, draft: AsyncQuestionDraft): string => {
  if (draft.submitted !== undefined) return draft.submitted;
  if (draft.adding) return draft.text.trim();
  return formatQuestionAnswerForRequest(request, draftPickedChoices(draft), draft.text);
};

export const draftReceiptMatches = (
  request: QuestionRequest,
  draft: AsyncQuestionDraft,
  receipt: QuestionRequest['receipt'] | undefined
): boolean => {
  const mutation = draft.mutation;
  if (!mutation || !receipt) return false;
  const expected = draft.submitted ?? (mutation.action === 'context'
    ? draft.text.trim()
    : formatQuestionAnswerForRequest(request, draftPickedChoices(draft), draft.text));
  return receipt.requestId === mutation.requestId
    && receipt.revision === mutation.revision
    && (receipt.answer === expected || (mutation.action === 'context' && receipt.answer === draft.text));
};

export const unlockQuestionDraft = (
  draft: AsyncQuestionDraft,
  options: { pending: boolean; sentAnswer?: string; optionOrder?: readonly string[] }
): AsyncQuestionDraft | undefined => {
  const picked = draft.picked?.length ? [...draft.picked] : undefined;
  if (draft.mutation?.action === 'withdraw') {
    if (!draft.text && !picked && !draft.accepted && !draft.adding) return undefined;
    return {
      text: draft.text,
      ...(picked ? { picked } : {}),
      ...(draft.accepted ? { accepted: draft.accepted } : {}),
      ...(draft.adding ? { adding: true } : {}),
    };
  }
  const accepted = !options.pending ? (draft.accepted ?? options.sentAnswer) : undefined;
  if (!options.pending) {
    const text = draft.mutation?.action !== 'context' && picked
      ? composeQuestionAnswer(options.optionOrder ?? [], picked, draft.text, true)
      : draft.text;
    return {
      text,
      adding: true,
      ...(accepted ? { accepted } : {}),
    };
  }
  return {
    text: draft.text,
    ...(picked ? { picked } : {}),
    adding: false,
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
    hasUnsent() {
      for (const draft of values.values()) {
        if (draft.text.length > 0 || (draft.picked?.length ?? 0) > 0 || draft.mutation !== undefined) return true;
      }
      return false;
    },
    unsentTexts(): string[] {
      const texts: string[] = [];
      for (const draft of values.values()) {
        if (draft.mutation && draft.submitted !== undefined) {
          if (draft.submitted) texts.push(draft.submitted);
          continue;
        }
        const picked = draft.picked?.length ? draft.picked.join('\n') : '';
        if (picked && draft.text) texts.push(`${picked}\n\n${draft.text}`);
        else if (picked) texts.push(picked);
        else if (draft.text) texts.push(draft.text);
      }
      return texts;
    },
    clear() {
      const keys = [...values.keys()];
      values.clear();
      for (const key of keys) listeners.get(key)?.forEach(listener => listener());
    },
  };
};
export const questionDrafts = createQuestionDraftStore();
