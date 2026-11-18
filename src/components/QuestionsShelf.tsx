import * as React from 'react';
import type { QuestionAnswers, QuestionRequest } from '../types';
import { questionKey } from '../lib/threadQuestions';
import {
  formatQuestionAnswerForRequest,
  isLongQuestionContext,
  questionFollowups,
  questionSourceMessage,
  questionSourceTitle,
  questionStatusLabel,
  questionSupervisor,
} from '../lib/asyncQuestions';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { useQuestionMutation, type QuestionAnswerHandler } from '../hooks/useQuestionMutation';
import type { QuestionOpenMode } from '../hooks/useQuestionComposer';

export const submitQuestionAnswer = async (
  onAnswer: QuestionAnswerHandler,
  request: QuestionRequest,
  answers: QuestionAnswers | null,
  onSuccess: () => void,
): Promise<boolean> => {
  const ok = await onAnswer(request, answers);
  if (ok === true) onSuccess();
  return ok;
};

const QuestionRow = ({
  request,
  followups,
  onAnswer,
  onOpenSource,
  onAnswerConflict,
  onSelectQuestion,
  onMutationSuccess,
  isSelected,
  answerModeOpen,
  hostLabel,
}: {
  request: QuestionRequest;
  followups: QuestionRequest[];
  hostLabel: string;
  onAnswer: QuestionAnswerHandler;
  onOpenSource?: (request: QuestionRequest) => void;
  onAnswerConflict?: () => void;
  onSelectQuestion?: (request: QuestionRequest, mode?: QuestionOpenMode) => void;
  onMutationSuccess?: (action: 'answer' | 'context' | 'withdraw', key: string) => void;
  isSelected?: boolean;
  answerModeOpen?: boolean;
}) => {
  const {
    draft,
    busy,
    copied,
    picked,
    pending,
    sentAnswer,
    failure,
    updateDraft,
    act,
    unlock,
    copyAnswer,
  } = useQuestionMutation({
    request,
    followups,
    hostLabel,
    onAnswer,
    onMutationSuccess,
    onAnswerConflict,
  });
  const [contextExpanded, setContextExpanded] = React.useState(false);
  const id = React.useId();

  const hasExtraContext = Boolean(
    request.context?.trim() || request.decision?.trim() || request.recommendation?.trim()
  );
  const longContext = isLongQuestionContext(request);
  const showFullContext = !longContext || contextExpanded;
  const draftSummary = formatQuestionAnswerForRequest(request, picked, draft.text);
  const copyableAnswer = !pending ? sentAnswer || draft.submitted || draftSummary : '';
  const activeSelection = Boolean(isSelected && answerModeOpen);

  const handleUnlock = () => {
    const unlocked = unlock();
    if (draft.mutation?.action !== 'withdraw' && onSelectQuestion) {
      onSelectQuestion(request, unlocked?.adding ? 'context' : 'answer');
    }
  };

  const handleAddContext = () => {
    if (onSelectQuestion) {
      onSelectQuestion(request, 'context');
      return;
    }
    updateDraft({ text: '', accepted: sentAnswer, adding: true });
  };

  return (
    <article
      aria-labelledby={id}
      aria-current={activeSelection ? 'true' : undefined}
      className={cn(
        'space-y-2 border-b border-border/50 py-3 last:border-0',
        activeSelection && 'rounded-md bg-highlight/5 px-2'
      )}
    >
      <div className="flex items-start justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{questionSourceTitle(request)}</span>
        {onOpenSource ? (
          <Button size="xs" variant="ghost" onClick={() => onOpenSource(request)}>
            {questionSourceMessage(request) ? 'Go to question' : 'Open source chat'}
          </Button>
        ) : null}
      </div>
      <p id={id} className="text-sm font-medium whitespace-pre-wrap">
        {request.questions.map((item) => item.question).join('\n')}
      </p>
      {hasExtraContext && longContext ? (
        <div className="space-y-1">
          {!showFullContext && request.context ? (
            <p className="line-clamp-1 text-xs text-muted-foreground">{request.context}</p>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={contextExpanded}
            onClick={() => setContextExpanded((open) => !open)}
            className="h-6 px-1.5 text-xs text-muted-foreground"
          >
            {contextExpanded ? 'Less context' : 'More context'}
          </Button>
        </div>
      ) : null}
      {hasExtraContext && showFullContext ? (
        <div className="space-y-1.5">
          {request.context ? (
            <p className="text-xs whitespace-pre-wrap text-muted-foreground">{request.context}</p>
          ) : null}
          {request.decision ? <p className="text-xs">Decision: {request.decision}</p> : null}
          {request.recommendation ? (
            <p className="text-xs whitespace-pre-wrap">
              <span className="font-medium">Recommendation: </span>
              {request.recommendation}
            </p>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        draft.mutation && !draft.failed ? (
          <p className="text-xs text-muted-foreground" role="status">
            {draft.mutation.action === 'withdraw' ? 'Withdrawing question…' : 'Sending answer…'}
          </p>
        ) : draftSummary && !draft.failed ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            Answer draft saved: {draftSummary}
          </p>
        ) : null
      ) : (
        <>
          <p className="text-xs text-muted-foreground" role="status">
            {questionStatusLabel(
              draft.accepted && request.status === 'pending'
                ? { ...request, status: 'answered' }
                : request
            )}
          </p>
          {request.delivery?.holdReason ? (
            <p className="text-xs text-muted-foreground">{request.delivery.holdReason}</p>
          ) : null}
          {sentAnswer ? <p className="text-sm whitespace-pre-wrap">Your answer: {sentAnswer}</p> : null}
        </>
      )}
      {followups.length ? (
        <ol aria-label="Additional context" className="space-y-3 border-l border-border pl-3">
          {followups.map((item) => (
            <li key={questionKey(item)}>
              <p className="text-sm whitespace-pre-wrap">{item.receipt?.answer ?? item.answer}</p>
              <p className="text-xs text-muted-foreground">{questionStatusLabel(item)}</p>
              {item.delivery?.holdReason ? (
                <p className="text-xs text-muted-foreground">{item.delivery.holdReason}</p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {pending && !draft.mutation ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant={activeSelection ? 'secondary' : 'outline'}
            aria-pressed={activeSelection ? true : undefined}
            onClick={() => onSelectQuestion?.(request, 'answer')}
          >
            {activeSelection ? 'Answering' : 'Answer'}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void act('withdraw')}
          >
            Withdraw question
          </Button>
        </div>
      ) : null}
      {!pending && request.status === 'answered' && !draft.mutation ? (
        followups.length < 100 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!draft.adding || !activeSelection ? (
              <Button type="button" size="xs" variant="ghost" onClick={handleAddContext}>
                Add more context
              </Button>
            ) : null}
            {copyableAnswer ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void copyAnswer(copyableAnswer)}
              >
                {copied ? 'Copied' : 'Copy answer'}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              This question has 100 additional messages. Open its source chat to continue.
            </p>
            {copyableAnswer ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void copyAnswer(copyableAnswer)}
              >
                {copied ? 'Copied' : 'Copy answer'}
              </Button>
            ) : null}
          </div>
        )
      ) : null}
      {!pending && request.status !== 'answered' && !draft.mutation && copyableAnswer ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void copyAnswer(copyableAnswer)}
          >
            {copied ? 'Copied' : 'Copy answer'}
          </Button>
        </div>
      ) : null}
      {failure ? (
        <>
          <p role="alert" className="text-xs text-destructive">
            {failure.message}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {failure.retryAction ? (
              <Button
                type="button"
                size="xs"
                disabled={busy}
                onClick={() => {
                  if (failure.retryAction) void act(failure.retryAction);
                }}
              >
                Retry
              </Button>
            ) : null}
            <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={handleUnlock}>
              {failure.unlockLabel}
            </Button>
          </div>
        </>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Source and delivery history</summary>
        <div className="space-y-1 pt-2">
          {request.ancestry?.map((item) => (
            <p key={item.conversationId}>{item.title || 'Conversation ' + item.conversationId}</p>
          ))}
          {request.source ? <p className="whitespace-pre-wrap">Source: {request.source}</p> : null}
          {!questionSourceMessage(request) ? (
            <p>Kiln has no saved link to this question’s original message.</p>
          ) : null}
          {request.origin?.taskKey ? <p>Assignment: {request.origin.taskKey}</p> : null}
          {request.receipt ? <p>Sent: {new Date(request.receipt.at).toLocaleString()}</p> : null}
          {request.delivery?.admittedAt ? (
            <p>Accepted for delivery: {new Date(request.delivery.admittedAt).toLocaleString()}</p>
          ) : null}
          <p>
            Sending does not confirm the bot has used your answer. Held answers never restart stopped
            or explicitly completed tasks. Open the source chat to decide how to continue.
          </p>
        </div>
      </details>
    </article>
  );
};

/**
 * Compact Questions tray above the composer: shows context, provenance, and actions without
 * inline textareas; selecting or answering opens the single QuestionAnswerComposer below.
 */
function QuestionsShelf({
  requests,
  sessionId,
  onAnswer,
  onOpenSource,
  onSelectQuestion,
  onMutationSuccess,
  activeKey = null,
  answerModeOpen = false,
  historyOpen: controlledHistoryOpen,
  onHistoryOpenChange,
  hostLabel = 'Kiln',
}: {
  requests: QuestionRequest[];
  sessionId: string;
  hostLabel?: string;
  onAnswer: QuestionAnswerHandler;
  onOpenSource?: (request: QuestionRequest) => void;
  onSelectQuestion?: (request: QuestionRequest, mode?: QuestionOpenMode) => void;
  onMutationSuccess?: (action: 'answer' | 'context' | 'withdraw', key: string) => void;
  activeKey?: string | null;
  answerModeOpen?: boolean;
  historyOpen?: boolean;
  onHistoryOpenChange?: (open: boolean) => void;
}) {
  const [limit, setLimit] = React.useState(20);
  const [internalHistoryOpen, setInternalHistoryOpen] = React.useState(false);
  const historyOpen = controlledHistoryOpen ?? internalHistoryOpen;
  const setHistoryOpen = onHistoryOpenChange ?? setInternalHistoryOpen;
  const revealHistory = React.useCallback(() => setHistoryOpen(true), [setHistoryOpen]);
  const roots = React.useMemo(() => requests.filter((request) => !request.replyTo), [requests]);
  const active = React.useMemo(
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
  const answer = React.useCallback<QuestionAnswerHandler>(
    (request, answers) => submitQuestionAnswer(onAnswer, request, answers, revealHistory),
    [onAnswer, revealHistory]
  );
  const render = (rows: QuestionRequest[], inHistory = false) => {
    const groups = new Map<string, QuestionRequest[]>();
    rows.forEach((request) => {
      const name = questionSupervisor(request, sessionId);
      groups.set(name, [...(groups.get(name) ?? []), request]);
    });
    return [...groups].map(([name, grouped]) => (
      <section key={name} aria-label={name}>
        <h3 className="pt-2 text-xs font-semibold">{name}</h3>
        {grouped.map((request) => {
          const key = questionKey(request);
          return (
            <QuestionRow
              key={key}
              request={request}
              followups={questionFollowups(request, requests)}
              hostLabel={hostLabel}
              onAnswer={answer}
              onAnswerConflict={inHistory ? revealHistory : undefined}
              onSelectQuestion={onSelectQuestion}
              onMutationSuccess={onMutationSuccess}
              isSelected={activeKey === key}
              answerModeOpen={answerModeOpen}
              onOpenSource={
                request.sessionId === sessionId && !questionSourceMessage(request)
                  ? undefined
                  : onOpenSource
              }
            />
          );
        })}
      </section>
    ));
  };
  return (
    <div className="max-h-[min(18rem,32dvh)] overflow-y-auto px-1" aria-label="Questions">
      <p className="py-2 text-xs text-muted-foreground">
        {active.length > 0
          ? 'Answer once, then add more context if you need to. The bot can keep working while you decide.'
          : 'No questions waiting for your answer.'}
      </p>
      {render(active)}
      {history.length ? (
        <details
          open={historyOpen}
          onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer py-2 text-xs text-muted-foreground">
            Answered and closed ({history.length})
          </summary>
          {render(history.slice(0, limit), true)}
          {history.length > limit ? (
            <Button size="sm" variant="ghost" onClick={() => setLimit((value) => value + 20)}>
              Show 20 more questions
            </Button>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

export default React.memo(QuestionsShelf);
