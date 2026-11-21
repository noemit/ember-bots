import * as React from 'react';
import { useSelectionComments } from '@/hooks/useSelectionComments';
import { createQuoteLinkId, validateQuoteAnchor, type QuoteAnchor } from '@/lib/quoteLinks';
import type { PromptInput } from '../../api';
import type { AnnotationGuard } from '../../lib/annotationNavigation';
import {
  isRemoteBrowser,
  isRemoteExpired,
  remoteAuxiliaryDrafts,
  setRemoteDraftBlocker,
} from '../../lib/remoteLifecycle';
import {
  sessionKey as makeSessionKey,
  type ChatMessage,
  type FileAttachment,
  type ModelOption,
  type Session,
} from '../../types';

type UseSelectionAnnotationsArgs = {
  composerKey: string | null;
  loadedComposerKey: string | null;
  session: Session | null;
  messages: ChatMessage[];
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  columnRef: React.RefObject<HTMLElement | null>;
  reloadBlockerKey: string;
  text: string;
  attachments: FileAttachment[];
  replyContext: unknown;
  sideQuestionText: string;
  model: ModelOption | undefined;
  modelId: string;
  variant: string;
  modelError: string | null;
  onBeforeNavigate?: (request: AnnotationGuard | null) => void;
  onAnnotate: (input: PromptInput, source: QuoteAnchor) => Promise<boolean>;
  onSaveAnnotationNote: (text: string, source: QuoteAnchor, requestId?: string) => Promise<boolean>;
};

export function useSelectionAnnotations({
  composerKey,
  loadedComposerKey,
  session,
  messages,
  transcriptRef,
  columnRef,
  reloadBlockerKey,
  text,
  attachments,
  replyContext,
  sideQuestionText,
  model,
  modelId,
  variant,
  modelError,
  onBeforeNavigate,
  onAnnotate,
  onSaveAnnotationNote,
}: UseSelectionAnnotationsArgs) {
  const [annotationDraft, setAnnotationDraft] = React.useState('');
  const [annotationBusy, setAnnotationBusy] = React.useState(false);
  const [annotationError, setAnnotationError] = React.useState<string | null>(null);
  const [annotationDecisionOpen, setAnnotationDecisionOpen] = React.useState(false);
  const annotationOperation = React.useRef<Promise<boolean> | null>(null);
  const annotationEpoch = React.useRef(0);
  const annotationDecisionResolver = React.useRef<((allowed: boolean) => void) | null>(null);
  const annotationDecisionPromise = React.useRef<Promise<boolean> | null>(null);
  const annotationRequestId = React.useRef<string | null>(null);

  const [annotationKey, setAnnotationKey] = React.useState<string | null>(composerKey);
  const annotationActions = React.useRef<{ clear: () => void; dismiss: () => void } | null>(null);

  const clearAnnotationEditor = React.useCallback(() => {
    annotationRequestId.current = null;
    setAnnotationDraft('');
    setAnnotationError(null);
    annotationActions.current?.clear();
    annotationActions.current?.dismiss();
  }, []);

  const settleAnnotationDecision = React.useCallback((allowed: boolean) => {
    setAnnotationDecisionOpen(false);
    annotationDecisionResolver.current?.(allowed);
    annotationDecisionResolver.current = null;
    annotationDecisionPromise.current = null;
  }, []);

  const discardAnnotation = React.useCallback(() => {
    clearAnnotationEditor();
    settleAnnotationDecision(true);
  }, [clearAnnotationEditor, settleAnnotationDecision]);

  const beginAnnotationDecision = React.useCallback(() => {
    if (annotationDecisionPromise.current) return annotationDecisionPromise.current;
    setAnnotationDecisionOpen(true);
    annotationDecisionPromise.current = new Promise<boolean>((resolve) => {
      annotationDecisionResolver.current = resolve;
    });
    return annotationDecisionPromise.current;
  }, []);

  const requestAnnotationDismiss = React.useCallback((): boolean | Promise<boolean> => {
    if (annotationDecisionPromise.current) return annotationDecisionPromise.current;
    if (annotationOperation.current) {
      return annotationOperation.current.then((accepted) => accepted || beginAnnotationDecision());
    }
    if (!annotationDraft.trim()) {
      clearAnnotationEditor();
      return true;
    }
    return beginAnnotationDecision();
  }, [annotationDraft, beginAnnotationDecision, clearAnnotationEditor]);

  const annotationDismissRef = React.useRef(requestAnnotationDismiss);
  annotationDismissRef.current = requestAnnotationDismiss;
  const navigationCallbackRef = React.useRef(onBeforeNavigate);
  navigationCallbackRef.current = onBeforeNavigate;

  React.useLayoutEffect(() => {
    navigationCallbackRef.current?.(() => annotationDismissRef.current());
    return () => {
      navigationCallbackRef.current?.(null);
      settleAnnotationDecision(false);
    };
  }, [composerKey, settleAnnotationDecision]);

  const selectionComments = useSelectionComments({
    regionRef: transcriptRef,
    hostRef: columnRef,
    enabled: Boolean(session),
    sessionKey: session ? makeSessionKey(session) : null,
    messages,
    hasDraft: Boolean(annotationDraft),
    onDismissRequest: requestAnnotationDismiss,
  });
  const { clearDraft: clearAnnotationSource, dismiss: dismissAnnotationEditor } = selectionComments;
  annotationActions.current = { clear: clearAnnotationSource, dismiss: dismissAnnotationEditor };

  const annotationSource = selectionComments.anchor;
  const annotationHasSource = Boolean(
    annotationSource?.quote.trim() &&
      annotationSource.spans.length &&
      session &&
      annotationSource.sessionKey === makeSessionKey(session)
  );
  const annotationSourceValid =
    annotationHasSource &&
    validateQuoteAnchor(annotationSource!, messages, session ? makeSessionKey(session) : undefined).valid;
  const annotationReason =
    selectionComments.reason ??
    (annotationHasSource && !annotationSourceValid
      ? 'Ember cannot find the unchanged passage, so it cannot link this annotation. Copy your text, then select the passage again to create a new annotation.'
      : null);

  React.useLayoutEffect(() => {
    annotationEpoch.current += 1;
    settleAnnotationDecision(false);
    setAnnotationDraft('');
    annotationRequestId.current = null;
    setAnnotationBusy(false);
    dismissAnnotationEditor();
    clearAnnotationSource();
    setAnnotationKey(composerKey);
    return () => {
      annotationEpoch.current += 1;
    };
  }, [composerKey, clearAnnotationSource, dismissAnnotationEditor, settleAnnotationDecision]);

  React.useLayoutEffect(() => {
    setRemoteDraftBlocker(
      reloadBlockerKey,
      Boolean(
        text.length ||
          attachments.length ||
          replyContext ||
          sideQuestionText.length ||
          annotationDraft.length ||
          annotationBusy
      )
    );
    if (isRemoteBrowser()) {
      if (sideQuestionText || annotationDraft) {
        remoteAuxiliaryDrafts.set(reloadBlockerKey, {
          question: sideQuestionText,
          annotationDraft,
          annotationQuote: annotationSource?.quote ?? '',
        });
      } else {
        remoteAuxiliaryDrafts.delete(reloadBlockerKey);
      }
    }
    return () => {
      setRemoteDraftBlocker(reloadBlockerKey, false);
      if (!isRemoteExpired()) remoteAuxiliaryDrafts.delete(reloadBlockerKey);
    };
  }, [reloadBlockerKey, text, attachments, replyContext, sideQuestionText, annotationDraft, annotationSource, annotationBusy]);

  const annotationInput = (value: string): PromptInput => ({
    requestId: (annotationRequestId.current ??= createQuoteLinkId()),
    text: `Re: “${annotationSource?.quote ?? ''}”\n\n${value.trim()}`,
    model,
    selectedModelId: modelId,
    mode: session?.agent,
    variant: variant || undefined,
  });

  const submitAnnotation = (asNote: boolean): Promise<boolean> => {
    if (annotationOperation.current) return annotationOperation.current;
    if (
      !annotationSource ||
      !annotationDraft.trim() ||
      !session ||
      !composerKey ||
      loadedComposerKey !== composerKey ||
      (!asNote && modelError)
    ) {
      return Promise.resolve(false);
    }
    if (!validateQuoteAnchor(annotationSource, messages, makeSessionKey(session)).valid) {
      return Promise.resolve(false);
    }
    const epoch = annotationEpoch.current;
    const input = annotationInput(annotationDraft);
    const source = annotationSource;
    setAnnotationError(null);
    setAnnotationBusy(true);
    const operation = (async () => {
      try {
        const accepted = asNote
          ? await onSaveAnnotationNote(input.text, source, input.requestId)
          : await onAnnotate(input, source);
        if (annotationEpoch.current === epoch) {
          if (accepted) {
            clearAnnotationEditor();
            settleAnnotationDecision(true);
          } else {
            setAnnotationError(
              asNote
                ? 'Ember could not save this annotation. Your text is still here; try Save again.'
                : 'Ember could not finish saving this annotation and its source link. Your text is still here; try Send again.'
            );
          }
        }
        return accepted && annotationEpoch.current === epoch;
      } catch {
        if (annotationEpoch.current === epoch) {
          setAnnotationError('Ember could not save this annotation. Your text is still here; try again.');
        }
        return false;
      } finally {
        annotationOperation.current = null;
        if (annotationEpoch.current === epoch) setAnnotationBusy(false);
      }
    })();
    annotationOperation.current = operation;
    return operation;
  };

  const sendAnnotation = () => submitAnnotation(false);
  const saveAnnotationNote = () => submitAnnotation(true);
  const handleAnnotationDraftChange = React.useCallback(
    (value: string) => {
      if (value !== annotationDraft) annotationRequestId.current = null;
      setAnnotationError(null);
      setAnnotationDraft(value);
    },
    [annotationDraft]
  );

  React.useEffect(() => {
    if (!annotationDraft.trim() && !annotationBusy) return;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [annotationDraft, annotationBusy]);

  return {
    annotationDraft,
    annotationBusy,
    annotationError,
    annotationDecisionOpen,
    annotationKey,
    selectionComments,
    annotationSource,
    annotationHasSource,
    annotationSourceValid,
    annotationReason,
    handleAnnotationDraftChange,
    settleAnnotationDecision,
    discardAnnotation,
    requestAnnotationDismiss,
    sendAnnotation,
    saveAnnotationNote,
  };
}
