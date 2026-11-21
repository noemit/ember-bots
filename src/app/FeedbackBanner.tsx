import type { ActionNotice } from '../hooks/useFeedback';
import { copyText } from '../lib/clipboard';

type Props = {
  actionError: string | null;
  actionErrorRetry: (() => void) | null;
  actionErrorRetryLabel: string | null;
  showActionError: (message: string | null, retry?: () => void, retryLabel?: string, onDismiss?: () => void) => void;
  errorCopied: boolean;
  setErrorCopied: (copied: boolean) => void;
  actionNotice: ActionNotice | null;
  setActionNotice: (notice: ActionNotice | null) => void;
  setNoticePaused: (paused: boolean) => void;
};

/**
 * Error + notice toast pills rendered inline in the top InstanceBar.
 */
export function FeedbackBanner({
  actionError,
  actionErrorRetry,
  actionErrorRetryLabel,
  showActionError,
  errorCopied,
  setErrorCopied,
  actionNotice,
  setActionNotice,
  setNoticePaused,
}: Props) {
  if (!actionError && !actionNotice) return null;

  return (
    <>
      {actionError ? (
        <div
          role="alert"
          className="animate-in fade-in flex h-7 min-w-0 items-center gap-2 rounded-full border border-destructive/40 bg-popover px-2.5 text-[11.5px] shadow-sm"
        >
          <span className="min-w-0 max-w-[44ch] truncate" title={actionError}>
            {actionError}
          </span>
          {actionErrorRetry ? (
            <button
              type="button"
              className="shrink-0 rounded font-medium text-highlight hover:underline focus-visible:outline-2"
              onClick={() => actionErrorRetry()}
              aria-label={actionErrorRetryLabel ?? 'Retry failed action'}
            >
              {actionErrorRetryLabel ?? 'Retry'}
            </button>
          ) : null}
          <button
            type="button"
            className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:outline-2"
            onClick={() => {
              void copyText(actionError).then((copied) => setErrorCopied(copied));
            }}
            aria-label="Copy error message"
          >
            {errorCopied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:outline-2"
            onClick={() => showActionError(null)}
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {actionNotice ? (
        <div
          role="status"
          aria-live="polite"
          onFocusCapture={() => setNoticePaused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setNoticePaused(false);
            }
          }}
          onPointerEnter={() => setNoticePaused(true)}
          onPointerLeave={() => setNoticePaused(false)}
          className="animate-in fade-in flex h-7 min-w-0 items-center gap-2 rounded-full border border-highlight/35 bg-popover px-2.5 text-[11.5px] shadow-sm"
        >
          {/* 60ch, not 44: a notice that says why ("nothing to compact — the recent turns already
              fit") loses its point when the clause after the dash is the part that gets clipped. */}
          <span className="min-w-0 max-w-[min(60ch,55vw)] truncate" title={actionNotice.message}>
            {actionNotice.message}
          </span>
          {actionNotice.actionLabel && actionNotice.action ? (
            <button
              type="button"
              className="shrink-0 rounded font-medium text-highlight hover:underline focus-visible:outline-2"
              onClick={() => {
                const action = actionNotice.action;
                setActionNotice(null);
                action?.();
              }}
            >
              {actionNotice.actionLabel}
            </button>
          ) : null}
          <button
            type="button"
            className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:outline-2"
            onClick={() => setActionNotice(null)}
            // "Close", not "Dismiss": a notice can now report that something *was* dismissed,
            // and two buttons saying "dismiss" beside each other would read as the same act.
            aria-label="Close message"
          >
            Close
          </button>
        </div>
      ) : null}
    </>
  );
}
