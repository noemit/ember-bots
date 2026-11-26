import * as React from 'react';
import type { QuestionRequest } from '../types';
import type { ShelfSectionId } from '../components/ComposerShelf';
import { questionKey } from '../lib/threadQuestions';
import { questionDrafts } from '../lib/asyncQuestionDrafts';

export type QuestionOpenMode = 'answer' | 'context' | 'view';

type Options = {
  composerKey: string | null;
  sessionId: string | null;
  asyncQuestions: readonly QuestionRequest[];
  shelfOpen: boolean;
  shelfSection: ShelfSectionId;
  setShelfOpen: (open: boolean) => void;
  setShelfSection: (section: ShelfSectionId) => void;
  onRestoreMainFocus: () => void;
};

export function useQuestionComposer({
  composerKey,
  sessionId,
  asyncQuestions,
  shelfOpen,
  shelfSection,
  setShelfOpen,
  setShelfSection,
  onRestoreMainFocus,
}: Options) {
  const [answerModeOpen, setAnswerModeOpen] = React.useState(false);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [focusRequest, setFocusRequest] = React.useState<{ key: string; token: number } | null>(null);
  const [settleTick, setSettleTick] = React.useState(0);
  const justAnsweredRef = React.useRef<{ key: string; index: number } | null>(null);

  const bumpFocus = React.useCallback((key: string) => {
    setFocusRequest((previous) => ({ key, token: (previous?.token ?? 0) + 1 }));
  }, []);

  React.useLayoutEffect(() => {
    setAnswerModeOpen(false);
    setSelectedKey(null);
    setHistoryOpen(false);
    setFocusRequest(null);
    justAnsweredRef.current = null;
  }, [composerKey]);

  const roots = React.useMemo(
    () => asyncQuestions.filter((request) => !request.replyTo),
    [asyncQuestions]
  );
  const pending = React.useMemo(
    () => roots.filter((request) => !request.status || request.status === 'pending'),
    [roots]
  );
  const history = React.useMemo(
    () =>
      roots
        .filter((request) => request.status && request.status !== 'pending')
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [roots]
  );

  const activeRequest = React.useMemo(() => {
    if (selectedKey) {
      const selected = roots.find((request) => questionKey(request) === selectedKey);
      if (selected) return selected;
    }
    return pending[0] ?? null;
  }, [pending, roots, selectedKey]);

  const activeKey = activeRequest ? questionKey(activeRequest) : null;
  const pendingIndex = activeKey ? pending.findIndex((request) => questionKey(request) === activeKey) : -1;
  const isAnswering = Boolean(
    sessionId && shelfOpen && shelfSection === 'questions' && answerModeOpen && activeRequest
  );
  const isChildTaskAnswer = Boolean(
    isAnswering && sessionId && activeRequest && activeRequest.sessionId !== sessionId
  );

  // Advance or restore normal chat once the refreshed question list reflects a submitted answer.
  React.useEffect(() => {
    const justAnswered = justAnsweredRef.current;
    if (!justAnswered) return;
    const finish = (settled: QuestionRequest | undefined) => {
      justAnsweredRef.current = null;
      if (settled?.delivery?.status === 'held' && settled.resumeRequired) {
        setSelectedKey(justAnswered.key);
        setAnswerModeOpen(true);
        return;
      }
      const remaining = pending.filter(
        (request) => questionKey(request) !== justAnswered.key && !questionDrafts.get(questionKey(request)).accepted
      );
      if (remaining.length > 0) {
        const next = remaining[Math.min(justAnswered.index, remaining.length - 1)] ?? remaining[0];
        const nextKey = questionKey(next);
        setSelectedKey(nextKey);
        setAnswerModeOpen(true);
        bumpFocus(nextKey);
        return;
      }
      setAnswerModeOpen(false);
      setSelectedKey(null);
      onRestoreMainFocus();
    };
    const settled = roots.find((request) => questionKey(request) === justAnswered.key);
    if (!settled || (settled.status && settled.status !== 'pending')) {
      finish(settled);
    }
  }, [bumpFocus, onRestoreMainFocus, pending, roots, settleTick]);

  const openQuestion = React.useCallback(
    (request: QuestionRequest, mode: QuestionOpenMode = 'answer') => {
      const key = questionKey(request);
      if (mode === 'context') {
        const current = questionDrafts.get(key);
        const sentAnswer = request.receipt?.answer ?? request.answer ?? current.accepted;
        questionDrafts.put(key, {
          text: current.adding ? current.text : '',
          ...(sentAnswer ? { accepted: sentAnswer } : {}),
          adding: true,
        });
      }
      justAnsweredRef.current = null;
      setSelectedKey(key);
      setAnswerModeOpen(true);
      setShelfSection('questions');
      setShelfOpen(true);
      bumpFocus(key);
    },
    [bumpFocus, setShelfOpen, setShelfSection]
  );

  const canResumeExistingSelection = React.useCallback(
    (key: string | null) => {
      if (!key) return false;
      const found = roots.find((request) => questionKey(request) === key);
      if (!found) return false;
      if (!found.status || found.status === 'pending') return true;
      const draft = questionDrafts.get(key);
      return Boolean(draft.adding || draft.failed || draft.mutation || (found.delivery?.status === 'held' && found.resumeRequired));
    },
    [roots]
  );

  const handleShelfSectionChange = React.useCallback(
    (nextSection: ShelfSectionId) => {
      setShelfSection(nextSection);
      if (nextSection !== 'questions') return;
      if (canResumeExistingSelection(selectedKey)) {
        setAnswerModeOpen(true);
        if (selectedKey) bumpFocus(selectedKey);
        return;
      }
      if (pending.length > 0) {
        const firstKey = questionKey(pending[0]);
        setSelectedKey(firstKey);
        setAnswerModeOpen(true);
        bumpFocus(firstKey);
      }
    },
    [bumpFocus, canResumeExistingSelection, pending, selectedKey, setShelfSection]
  );

  const handleShelfOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setShelfOpen(nextOpen);
      if (!nextOpen || shelfSection !== 'questions') return;
      if (canResumeExistingSelection(selectedKey)) {
        setAnswerModeOpen(true);
        return;
      }
      if (pending.length > 0) {
        const firstKey = questionKey(pending[0]);
        setSelectedKey(firstKey);
        setAnswerModeOpen(true);
        bumpFocus(firstKey);
      }
    },
    [bumpFocus, canResumeExistingSelection, pending, selectedKey, setShelfOpen, shelfSection]
  );

  const backToChat = React.useCallback(() => {
    justAnsweredRef.current = null;
    setAnswerModeOpen(false);
    onRestoreMainFocus();
  }, [onRestoreMainFocus]);

  const previousQuestion = React.useCallback(() => {
    if (pending.length <= 1) return;
    const base = pendingIndex >= 0 ? pendingIndex : 0;
    const next = pending[(base - 1 + pending.length) % pending.length];
    const key = questionKey(next);
    setSelectedKey(key);
    bumpFocus(key);
  }, [bumpFocus, pending, pendingIndex]);

  const nextQuestion = React.useCallback(() => {
    if (pending.length <= 1) return;
    const base = pendingIndex >= 0 ? pendingIndex : 0;
    const next = pending[(base + 1) % pending.length];
    const key = questionKey(next);
    setSelectedKey(key);
    bumpFocus(key);
  }, [bumpFocus, pending, pendingIndex]);

  const revealHistory = React.useCallback(() => setHistoryOpen(true), []);

  const handleMutationSuccess = React.useCallback(
    (action: 'answer' | 'context' | 'withdraw', key: string) => {
      setHistoryOpen(true);
      if (action === 'answer') {
        const index = pending.findIndex((request) => questionKey(request) === key);
        justAnsweredRef.current = { key, index: Math.max(0, index) };
        setSettleTick((value) => value + 1);
        return;
      }
      if (action === 'context') {
        const settled = roots.find((request) => questionKey(request) === key);
        const latestFollowup = settled
          ? asyncQuestions.filter((entry) => entry.replyTo === settled.id).at(-1)
          : undefined;
        const held =
          (settled?.delivery?.status === 'held' && settled.resumeRequired) ||
          (latestFollowup?.delivery?.status === 'held' && latestFollowup.resumeRequired);
        if (held) return;
        setAnswerModeOpen(false);
        setSelectedKey(null);
        onRestoreMainFocus();
        return;
      }
      // Withdrawal succeeded: advance if viewing the withdrawn question and another pending remains, else return to chat.
      if (selectedKey === key || activeKey === key) {
        const remaining = pending.filter((request) => questionKey(request) !== key);
        if (remaining.length > 0) {
          const nextKey = questionKey(remaining[0]);
          setSelectedKey(nextKey);
          bumpFocus(nextKey);
        } else {
          setAnswerModeOpen(false);
          setSelectedKey(null);
          onRestoreMainFocus();
        }
      }
    },
    [activeKey, asyncQuestions, bumpFocus, onRestoreMainFocus, pending, roots, selectedKey]
  );

  return {
    roots,
    pending,
    history,
    activeRequest,
    activeKey,
    pendingIndex,
    isAnswering,
    isChildTaskAnswer,
    answerModeOpen,
    historyOpen,
    setHistoryOpen,
    revealHistory,
    focusRequest,
    openQuestion,
    handleShelfSectionChange,
    handleShelfOpenChange,
    backToChat,
    previousQuestion,
    nextQuestion,
    handleMutationSuccess,
  };
}
