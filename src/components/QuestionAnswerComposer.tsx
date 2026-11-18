import * as React from 'react';
import { ArrowUp, Check, Loader2, Square } from 'lucide-react';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { shortcutLabel } from '@/lib/shortcuts';
import {
  allowsFreeTextQuestionNote,
  allowsMultipleQuestionChoices,
  formatQuestionAnswerForRequest,
  orderQuestionChoices,
  questionOptions,
  questionRecipientLabel,
  questionSourceTitle,
  questionStatusLabel,
} from '@/lib/asyncQuestions';
import {
  draftPickedChoices,
  questionDrafts,
  type AsyncQuestionDraft as Draft,
} from '@/lib/asyncQuestionDrafts';
import { useQuestionMutation, type QuestionAnswerHandler } from '@/hooks/useQuestionMutation';
import type { QuestionAnswers, QuestionRequest } from '../types';

export const submitQuestionMutation = async (
  onAnswer: QuestionAnswerHandler,
  request: QuestionRequest,
  answers: QuestionAnswers | null,
  onSuccess: () => void
): Promise<boolean> => {
  const ok = await onAnswer(request, answers);
  if (ok === true) onSuccess();
  return ok;
};

export const canSubmitQuestionComposer = (
  request: QuestionRequest,
  draft: Draft
): boolean => {
  if (draft.adding) return Boolean(draft.text.trim());
  if (request.status && request.status !== 'pending') return false;
  if (draft.accepted) return false;
  return Boolean(
    formatQuestionAnswerForRequest(request, draftPickedChoices(draft), draft.text).trim()
  );
};

export const copyableQuestionComposerAnswer = (
  request: QuestionRequest,
  draft: Draft,
  sentAnswer?: string
): string => {
  if (sentAnswer) return sentAnswer;
  if (draft.submitted) return draft.submitted;
  return formatQuestionAnswerForRequest(request, draftPickedChoices(draft), draft.text);
};

type Props = {
  request: QuestionRequest;
  followups: QuestionRequest[];
  sessionId: string;
  hostLabel?: string;
  pendingCount: number;
  pendingIndex: number;
  onPrevious: () => void;
  onNext: () => void;
  onBackToChat: () => void;
  onAnswer: QuestionAnswerHandler;
  onMutationSuccess?: (action: 'answer' | 'context' | 'withdraw', key: string) => void;
  onAnswerConflict?: () => void;
  focusRequest?: { key: string; token: number } | null;
  sessionBusy?: boolean;
  stoppingNow?: boolean;
  onAbort?: () => void;
};

/**
 * Single-composer answer mode rendered inside the main composer surface for Kiln async questions.
 */
export default function QuestionAnswerComposer({
  request,
  followups,
  sessionId,
  hostLabel = 'Kiln',
  pendingCount,
  pendingIndex,
  onPrevious,
  onNext,
  onBackToChat,
  onAnswer,
  onMutationSuccess,
  onAnswerConflict,
  focusRequest,
  sessionBusy = false,
  stoppingNow = false,
  onAbort,
}: Props) {
  const {
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
  } = useQuestionMutation({
    request,
    followups,
    hostLabel,
    onAnswer,
    onMutationSuccess,
    onAnswerConflict,
  });

  const firstOptionRef = React.useRef<HTMLButtonElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const retryButtonRef = React.useRef<HTMLButtonElement>(null);
  const backButtonRef = React.useRef<HTMLButtonElement>(null);
  const inputId = React.useId();

  const options = questionOptions(request);
  const allowMultiple = allowsMultipleQuestionChoices(request);
  const allowFreeText = allowsFreeTextQuestionNote(request);
  const recipientHeading = questionRecipientLabel(request, sessionId);
  const recipientTarget =
    request.sessionId === sessionId ? 'this conversation' : questionSourceTitle(request);
  const questionText = request.questions.map((item) => item.question).join('\n');

  const isClosed =
    request.status === 'withdrawn' ||
    request.status === 'cancelled' ||
    request.status === 'superseded';
  const locked = isSending || Boolean(draft.mutation) || (!pending && !draft.adding);
  const canSubmit = canSubmitQuestionComposer(request, draft);
  const showChips =
    options.length > 0 &&
    !draft.adding &&
    (pending ||
      draft.mutation?.action === 'answer' ||
      draft.mutation?.action === 'withdraw' ||
      isClosed);
  const showNoteInput =
    draft.adding ||
    (pending && allowFreeText) ||
    ((isSending || Boolean(failure) || isClosed) && (allowFreeText || Boolean(draft.text)));
  const showSendButton = pending || draft.adding || isSending;
  const copyableAnswer = copyableQuestionComposerAnswer(
    request,
    draft,
    pending ? undefined : sentAnswer
  );

  React.useEffect(() => {
    if (!focusRequest || focusRequest.key !== key) return;
    const frame = window.requestAnimationFrame(() => {
      if (failure?.retryAction && retryButtonRef.current) {
        retryButtonRef.current.focus({ preventScroll: true });
        return;
      }
      if ((options.length === 0 || draft.adding) && showNoteInput && !locked && textareaRef.current) {
        textareaRef.current.focus({ preventScroll: true });
        return;
      }
      if (showChips && !locked && firstOptionRef.current) {
        firstOptionRef.current.focus({ preventScroll: true });
        return;
      }
      if (showNoteInput && !locked && textareaRef.current) {
        textareaRef.current.focus({ preventScroll: true });
        return;
      }
      backButtonRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
    // Focus only when focusRequest.token advances from an explicit user action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.token, focusRequest?.key]);

  const toggleOption = (label: string) => {
    const latest = questionDrafts.get(key);
    const latestPending = (!request.status || request.status === 'pending') && !latest.accepted;
    const latestLocked = Boolean(latest.mutation) || (!latestPending && !latest.adding);
    if (latestLocked || !latestPending) return;
    const currentPicked = draftPickedChoices(latest);
    const has = currentPicked.includes(label);
    const nextRaw = allowMultiple
      ? has
        ? currentPicked.filter((entry) => entry !== label)
        : [...currentPicked, label]
      : has && currentPicked.length === 1 && allowFreeText
        ? []
        : [label];
    updateDraft({ ...latest, picked: orderQuestionChoices(optionLabels, nextRaw) });
  };

  const submitAction: 'answer' | 'context' = draft.adding || !pending ? 'context' : 'answer';

  return (
    <section
      aria-label="Answer to this question"
      data-question-answer-composer=""
      className="@container flex min-w-0 flex-col"
    >
      <header className="flex min-h-9 items-center gap-2 border-b border-border/60 px-3 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={recipientHeading}>
          {recipientHeading}
        </span>
        {pendingCount > 1 && pendingIndex >= 0 ? (
          <div className="flex flex-none items-center gap-0.5" role="group" aria-label="Question pager">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Previous question"
              onClick={onPrevious}
              className="size-8 min-h-8 min-w-8 text-muted-foreground hover:text-foreground"
            >
              ‹
            </Button>
            <span className="min-w-8 text-center text-[11px] tabular-nums text-muted-foreground">
              {pendingIndex + 1} / {pendingCount}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Next question"
              onClick={onNext}
              className="size-8 min-h-8 min-w-8 text-muted-foreground hover:text-foreground"
            >
              ›
            </Button>
          </div>
        ) : null}
      </header>

      {isSending ? (
        <div
          role="status"
          className="mx-3 mt-2 max-h-24 overflow-y-auto rounded-md border border-border/70 bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground"
        >
          <p className="font-medium text-foreground">Sending to {host}…</p>
          <p className="mt-0.5">Your submitted answer stays here.</p>
        </div>
      ) : failure ? (
        <div className="mx-3 mt-2 max-h-28 overflow-y-auto rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs">
          <p role="alert" className="text-destructive">
            {failure.message}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {failure.retryAction ? (
              <Button
                ref={retryButtonRef}
                type="button"
                size="xs"
                disabled={busy}
                onClick={() => void act(failure.retryAction!)}
              >
                Retry
              </Button>
            ) : null}
            <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={unlock}>
              {failure.unlockLabel}
            </Button>
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
        </div>
      ) : isClosed ? (
        <div
          role="status"
          className="mx-3 mt-2 max-h-24 overflow-y-auto rounded-md border border-border/70 bg-muted/40 px-2.5 py-2 text-xs"
        >
          <p className="font-medium text-foreground">{questionStatusLabel(request)}</p>
          <p className="mt-0.5 text-muted-foreground">No answer can be sent.</p>
          {copyableAnswer ? (
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
        </div>
      ) : request.status === 'answered' && !draft.adding ? (
        <div
          role="status"
          className="mx-3 mt-2 max-h-28 overflow-y-auto rounded-md border border-border/70 bg-muted/40 px-2.5 py-2 text-xs"
        >
          <p className="font-medium text-foreground">{questionStatusLabel(request)}</p>
          {request.delivery?.holdReason ? (
            <p className="mt-0.5 text-muted-foreground">{request.delivery.holdReason}</p>
          ) : null}
          {sentAnswer ? (
            <p className="mt-1 whitespace-pre-wrap text-foreground">Your answer: {sentAnswer}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {followups.length < 100 ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
              updateDraft({
                text: '',
                accepted: sentAnswer,
                adding: true,
              });
              window.requestAnimationFrame(() =>
                textareaRef.current?.focus({ preventScroll: true })
              );
            }}
              >
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
        </div>
      ) : null}

      {showChips ? (
        <div
          role="group"
          aria-label="Answer choices"
          className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto px-3 pt-2 pb-1 [scrollbar-width:thin]"
        >
          {options.map((option, index) => {
            const selected = picked.includes(option.label);
            return (
              <button
                key={option.label}
                ref={index === 0 ? firstOptionRef : undefined}
                type="button"
                aria-pressed={selected}
                disabled={locked || !pending}
                onClick={() => toggleOption(option.label)}
                className={cn(
                  'inline-flex min-h-8 max-w-full items-start gap-1.5 rounded-lg border px-2.5 py-1 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60',
                  selected
                    ? 'border-highlight bg-highlight/15 font-medium text-foreground'
                    : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 flex size-3.5 flex-none items-center justify-center border',
                    allowMultiple ? 'rounded-[3px]' : 'rounded-full',
                    selected
                      ? 'border-highlight bg-highlight text-highlight-foreground'
                      : 'border-muted-foreground/50'
                  )}
                >
                  {selected ? <Check className="size-2.5" /> : null}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="break-words">{option.label}</span>
                  {option.description ? (
                    <span className="text-[11px] font-normal text-muted-foreground break-words">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {showNoteInput ? (
        <div className="min-w-0">
          <label htmlFor={inputId} className="sr-only">
            {draft.adding
              ? `Additional context for ${questionText}`
              : options.length > 0
                ? `Add a note for ${questionText}`
                : `Your answer to ${questionText}`}
          </label>
          <AutoResizeTextarea
            id={inputId}
            ref={textareaRef}
            value={draft.text}
            disabled={locked}
            maxHeight={108}
            resizable={false}
            maxLength={32000}
            aria-label={
              draft.adding
                ? 'Additional context'
                : options.length > 0
                  ? 'Add a note'
                  : 'Your answer'
            }
            placeholder={
              draft.adding
                ? 'Add context without changing your original answer'
                : options.length > 0
                  ? 'Add a note…'
                  : 'Tell this bot what to do…'
            }
            onPaste={(event) => {
              if (
                event.clipboardData.files.length > 0 &&
                !event.clipboardData.getData('text/plain')
              ) {
                event.preventDefault();
              }
            }}
            onChange={(event) => {
              const latest = questionDrafts.get(key);
              const latestPending =
                (!request.status || request.status === 'pending') && !latest.accepted;
              const latestLocked = Boolean(latest.mutation) || (!latestPending && !latest.adding);
              if (latestLocked) return;
              updateDraft({ ...latest, text: event.target.value });
            }}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key === 'Enter' &&
                !event.nativeEvent?.isComposing &&
                !locked &&
                canSubmit
              ) {
                event.preventDefault();
                void act(submitAction);
              }
            }}
            className="min-h-9 w-full bg-transparent px-3 pt-2 pb-1 text-base placeholder:text-muted-foreground focus-visible:border-input focus-visible:ring-0 disabled:cursor-not-allowed sm:px-3.5 sm:text-[13px]"
          />
        </div>
      ) : null}

      <div className="flex items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5 sm:px-3">
        <span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground @[380px]:block">
          {draft.adding
            ? 'Appends context without changing your original answer'
            : 'Your chat draft stays saved'}
        </span>
        <div className="ml-auto flex flex-none items-center gap-1.5">
          {sessionBusy && onAbort ? (
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              className="size-7 rounded-full"
              onClick={onAbort}
              disabled={stoppingNow}
              aria-label={stoppingNow ? 'Stopping' : 'Stop generating'}
              title={stoppingNow ? 'Stopping…' : 'Stop generating'}
            >
              {stoppingNow ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Square className="size-3 fill-current" />
              )}
            </Button>
          ) : null}
          <Button
            ref={backButtonRef}
            type="button"
            size="sm"
            variant="ghost"
            onClick={onBackToChat}
            className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <span>Back to chat</span>
            <kbd className="hidden rounded border border-border/80 px-1 py-0.5 text-[10px] font-normal text-muted-foreground @[340px]:inline">
              Esc
            </kbd>
          </Button>
          {showSendButton ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="button"
                    size="icon-sm"
                    disabled={isSending || !canSubmit || locked}
                    aria-busy={isSending || undefined}
                    aria-label={isSending ? 'Sending answer' : 'Send answer'}
                    aria-keyshortcuts="Meta+Enter Control+Enter"
                    onClick={() => void act(submitAction)}
                    className="size-8 flex-none rounded-full bg-highlight text-highlight-foreground hover:bg-highlight/90 disabled:bg-muted disabled:text-muted-foreground"
                  >
                    {isSending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ArrowUp className="size-4" />
                    )}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {isSending
                  ? `Sending answer to ${host}`
                  : shortcutLabel(`Send answer to ${recipientTarget} · Mod+Enter`)}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </section>
  );
}
