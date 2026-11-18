import * as React from 'react';
import { copyText } from '@/lib/clipboard';
import { randomId } from '@/lib/randomId';
import { questionKey } from '@/lib/threadQuestions';
import { questionOptionLabels } from '@/lib/asyncQuestions';
import {
  draftAnswerPayload,
  draftPickedChoices,
  draftReceiptMatches,
  questionDrafts,
  questionFailureRecovery,
  unlockQuestionDraft,
  type AsyncQuestionDraft as Draft,
} from '@/lib/asyncQuestionDrafts';
import type { QuestionAnswers, QuestionRequest } from '../types';

export type QuestionAnswerHandler = (
  request: QuestionRequest,
  answers: QuestionAnswers | null
) => Promise<boolean>;

type Options = {
  request: QuestionRequest;
  followups: readonly QuestionRequest[];
  hostLabel?: string;
  onAnswer: QuestionAnswerHandler;
  onMutationSuccess?: (action: 'answer' | 'context' | 'withdraw', key: string) => void;
  onAnswerConflict?: () => void;
};

/**
 * Shared draft subscription, receipt settlement, retry, unlock, and copy mechanics for
 * both the Questions shelf rows and the single-composer QuestionAnswerComposer.
 */
export function useQuestionMutation({
  request,
  followups,
  hostLabel = 'Kiln',
  onAnswer,
  onMutationSuccess,
  onAnswerConflict,
}: Options) {
  const key = questionKey(request);
  const subscribe = React.useCallback(
    (listener: () => void) => questionDrafts.subscribe(key, listener),
    [key]
  );
  const getDraft = React.useCallback(() => questionDrafts.get(key), [key]);
  const draft = React.useSyncExternalStore(subscribe, getDraft, getDraft);

  const [inFlight, setInFlight] = React.useState<{ key: string; requestId: string } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const inFlightRef = React.useRef<{ key: string; requestId: string } | null>(null);
  const copyTimerRef = React.useRef<number | undefined>(undefined);

  React.useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  const optionLabels = questionOptionLabels(request);
  const picked = draftPickedChoices(draft);
  const pending = (!request.status || request.status === 'pending') && !draft.accepted;
  const sentAnswer = request.receipt?.answer ?? request.answer ?? draft.accepted;
  const host = hostLabel.trim() || 'Kiln';
  // Scope in-flight busy state to the exact (key, requestId) so canonical poll confirmation
  // unlocks Answer Mode immediately even if the original HTTP response is still held.
  const busy = Boolean(
    inFlight &&
      inFlight.key === key &&
      draft.mutation?.requestId === inFlight.requestId
  );
  const isSending = busy || Boolean(draft.mutation && !draft.failed);
  const failure = questionFailureRecovery(request, draft, host, busy);
  const answerConflict = Boolean(
    draft.mutation?.action === 'answer' &&
      request.status === 'answered' &&
      request.receipt &&
      request.receipt.requestId !== draft.mutation?.requestId
  );

  React.useEffect(() => {
    if (draft.failed && answerConflict) onAnswerConflict?.();
  }, [answerConflict, draft.failed, onAnswerConflict]);

  React.useEffect(() => {
    const mutation = draft.mutation;
    if (!mutation) return;
    if (mutation.action === 'withdraw') {
      if (
        request.status === 'withdrawn' &&
        request.mutation?.action === 'withdraw' &&
        request.mutation.requestId === mutation.requestId &&
        request.mutation.revision === mutation.revision
      ) {
        if (questionDrafts.settle(key, mutation.requestId, undefined)) {
          onMutationSuccess?.('withdraw', key);
        }
      }
      return;
    }
    const receipts =
      mutation.action === 'context'
        ? followups.map((item) => item.receipt)
        : [request.receipt];
    const confirmed = receipts.some((receipt) => draftReceiptMatches(request, draft, receipt));
    if (!confirmed) return;
    const next: Draft = { text: '', accepted: sentAnswer };
    if (questionDrafts.settle(key, mutation.requestId, next)) {
      onMutationSuccess?.(mutation.action === 'context' ? 'context' : 'answer', key);
    }
  }, [draft, followups, key, onMutationSuccess, request, sentAnswer]);

  const updateDraft = React.useCallback(
    (next?: Draft) => {
      if (!next) {
        questionDrafts.put(key, undefined);
        return;
      }
      const cleanedPicked = next.picked?.length ? next.picked : undefined;
      if (
        !next.text &&
        !cleanedPicked &&
        !next.mutation &&
        !next.failed &&
        !next.accepted &&
        !next.adding &&
        next.submitted === undefined
      ) {
        questionDrafts.put(key, undefined);
        return;
      }
      questionDrafts.put(key, {
        text: next.text,
        ...(cleanedPicked ? { picked: cleanedPicked } : {}),
        ...(next.submitted !== undefined ? { submitted: next.submitted } : {}),
        ...(next.mutation ? { mutation: next.mutation } : {}),
        ...(next.failed ? { failed: true } : {}),
        ...(next.accepted ? { accepted: next.accepted } : {}),
        ...(next.adding ? { adding: true } : {}),
      });
    },
    [key]
  );

  const act = async (action: 'answer' | 'withdraw' | 'context') => {
    const activeOnKey =
      inFlightRef.current?.key === key &&
      inFlightRef.current?.requestId === draft.mutation?.requestId;
    if (
      activeOnKey ||
      (draft.mutation && !draft.failed) ||
      (draft.mutation && draft.mutation.action !== action)
    ) {
      return;
    }
    const payload = action === 'withdraw' ? '' : draftAnswerPayload(request, draft);
    if (action !== 'withdraw' && !payload.trim()) return;
    const mutation = draft.mutation ?? {
      requestId: randomId(),
      revision: request.revision ?? 1,
      action,
    };
    const next: Draft = {
      ...draft,
      ...(action === 'withdraw' ? {} : { submitted: payload }),
      mutation,
      failed: false,
    };
    const token = { key, requestId: mutation.requestId };
    questionDrafts.put(key, next);
    inFlightRef.current = token;
    setInFlight(token);
    try {
      const ok = await onAnswer({ ...request, mutation }, [[payload]]);
      if (ok) {
        const accepted = action === 'answer' ? payload : sentAnswer;
        if (
          questionDrafts.settle(
            key,
            mutation.requestId,
            accepted ? { text: '', accepted } : undefined
          )
        ) {
          onMutationSuccess?.(action, key);
        }
      } else {
        questionDrafts.settle(key, mutation.requestId, { ...next, failed: true });
      }
    } catch {
      questionDrafts.settle(key, mutation.requestId, { ...next, failed: true });
    } finally {
      if (inFlightRef.current === token) {
        inFlightRef.current = null;
        setInFlight(null);
      }
    }
  };

  const unlock = () => {
    const unlocked = unlockQuestionDraft(draft, {
      pending,
      sentAnswer,
      optionOrder: optionLabels,
    });
    updateDraft(unlocked);
    return unlocked;
  };

  const copyAnswer = async (text: string) => {
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return {
    key,
    draft,
    busy,
    copied,
    host,
    optionLabels,
    picked,
    pending,
    sentAnswer,
    isSending,
    failure,
    updateDraft,
    act,
    unlock,
    copyAnswer,
  };
}
