import * as React from 'react';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  piCancelProviderLogin,
  piAnswerProviderLogin,
  piPollProviderLogin,
  piStartProviderLogin,
  type PiLoginEvent,
} from '@/piApi';
import { copyText } from '@/lib/clipboard';
import { judgeLoginAnswer, signInAddressLabel } from '@/lib/loginAnswer';
import { loginPollOutcome, verificationHostLabel } from '@/lib/providerLogin';

/** A question a flow is blocked on, as the dialog last saw it. */
type LoginQuestion = { message: string; placeholder?: string; answer?: string; askedAt: number };

type Props = {
  open: boolean;
  endpointId: string;
  providerId: string;
  providerName: string;
  onOpenChange: (open: boolean) => void;
  /** Called once the credential lands, so the parent can reload the provider list. */
  onSignedIn: () => void;
};

/** How often to ask Hearth whether the human has approved yet. */
const POLL_MS = 2000;

const deviceEvent = (events: PiLoginEvent[] | undefined) =>
  events?.find((event): event is Extract<PiLoginEvent, { type: 'device_code' }> => event.type === 'device_code');

/**
 * The question the human must answer, or none.
 *
 * Only the *latest* question counts: a flow that rejected an answer asks again, and falling back to
 * an earlier one would let the dialog re-show a question that has already been settled. (A question
 * is "settled" by the host recording the answer, not by this dialog hiding it — the flow asks again
 * if it needs something else, and the newer question is the one on screen.)
 */
const questionEvent = (events: PiLoginEvent[] | undefined) =>
  [...(events ?? [])].reverse().find(
    (event): event is Extract<PiLoginEvent, { type: 'question' }> => event.type === 'question'
  );

/**
 * OAuth sign-in, driven by Hearth's start/poll pair.
 *
 * The whole point is that the human finishes elsewhere (a browser, possibly on a phone), so this
 * dialog's job is to make what they need easy to read and carry: a clickable link, a copyable device
 * code, or — for a browser sign-in whose loopback callback the browser cannot reach — a field to
 * paste the redirect URL back into. It deliberately does **not** close on a backdrop click while a
 * flow is pending (dismissing the dialog would abandon an authentication the user is halfway
 * through), so the only exits are Cancel and Close.
 */
export default function ProviderSignInDialog({
  open,
  endpointId,
  providerId,
  providerName,
  onOpenChange,
  onSignedIn,
}: Props) {
  const [events, setEvents] = React.useState<PiLoginEvent[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  /** The question on screen, its draft answer, and why the draft was refused (if it was). */
  const [question, setQuestion] = React.useState<LoginQuestion | null>(null);
  const [answerDraft, setAnswerDraft] = React.useState('');
  const [answerProblem, setAnswerProblem] = React.useState<string | null>(null);
  const [sendingAnswer, setSendingAnswer] = React.useState(false);
  const stopPolling = React.useRef(() => {});
  /**
   * Parents pass an inline arrow, so `onSignedIn` is a new function on every render. Keeping it in a
   * ref keeps it out of the effect's dependencies: otherwise each render restarts the effect, whose
   * cleanup cancels the login that was already in flight — which surfaced as "cancelled" the moment
   * the dialog opened.
   */
  const signedIn = React.useRef(onSignedIn);
  signedIn.current = onSignedIn;

  React.useEffect(() => {
    if (!open) return;
    // Each effect owns its cancellation flag. A retry or StrictMode remount must never revive
    // the previous attempt's request or polling loop when it eventually answers.
    let stopped = false;
    stopPolling.current = () => { stopped = true; };
    setEvents([]);
    setError(null);
    setDone(false);
    setCopied(false);
    setStarting(true);
    setQuestion(null);
    setAnswerDraft('');
    setAnswerProblem(null);

    void (async () => {
      const started = await piStartProviderLogin(endpointId, providerId);
      if (stopped) return;
      setStarting(false);
      if (!started.ok) {
        setError(started.error ?? 'Could not start signing in.');
        return;
      }
      if (started.state) setEvents(started.state.events ?? []);
      // A flow can be waiting on an answer before the first request even returns (the browser sign-in
      // asks as soon as it has a link to show), so the question is read here as well as on each poll.
      const firstQuestion = questionEvent(started.state?.events);
      if (firstQuestion && started.state?.status === 'pending') {
        setQuestion({ message: firstQuestion.message, placeholder: firstQuestion.placeholder, askedAt: Date.now() });
      }
      if (started.state?.status === 'complete') {
        setDone(true);
        signedIn.current();
        return;
      }
      if (started.state?.status === 'failed') {
        setError(started.state.error ?? 'Signing in failed.');
        return;
      }

      // Poll until the human approves (or it expires).
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (stopped) return;
        const polled = await piPollProviderLogin(endpointId, providerId);
        if (stopped) return;
        const outcome = loginPollOutcome(polled);
        if (outcome.kind === 'complete') {
          setDone(true);
          signedIn.current();
          return;
        }
        if (outcome.kind === 'failed' || outcome.kind === 'unreachable') {
          setError(outcome.error);
          return;
        }
        const next = polled.state?.events ?? [];
        setEvents(next);
        const asked = questionEvent(next);
        setQuestion((current) =>
          asked
            ? {
                message: asked.message,
                placeholder: asked.placeholder,
                // Keep the draft across a re-ask of the *same* question: the usual re-ask quotes the
                // rejection back at us, and losing what they typed makes them paste it again.
                answer: current && current.placeholder === asked.placeholder ? current.answer : undefined,
                askedAt: Date.now(),
              }
            : null
        );
      }
    })();

    return () => {
      // Stop polling, but leave the flow running on the host: a StrictMode remount (or a re-render
      // path) must not cancel an authentication the user is completing in another window.
      // Only the explicit Cancel button ends it.
      stopped = true;
    };
  }, [open, endpointId, providerId, attempt]);

  /**
   * Send the typed reply to the host.
   *
   * The draft is judged before it is sent: an empty field waits, and an obvious non-answer is
   * explained beside the field instead of becoming a rejection from Google that reads as "it did
   * not work". The dialog stays open and keeps polling either way — a refusal re-asks, and the
   * human's answer is still in the field to fix.
   */
  const submitAnswer = async () => {
    const verdict = judgeLoginAnswer(answerDraft, question?.placeholder);
    if (!verdict.ok) {
      setAnswerProblem(verdict.reason);
      return;
    }
    setSendingAnswer(true);
    setAnswerProblem(null);
    const sent = await piAnswerProviderLogin(endpointId, providerId, verdict.value);
    setSendingAnswer(false);
    if (!sent.ok) {
      setAnswerProblem(sent.error ?? `${providerName}’s host did not take that answer. Check the address and try again.`);
      return;
    }
    // The host took it; the question it belonged to is answered until a new one arrives.
    setQuestion(null);
    setAnswerDraft('');
  };
  const cancel = async () => {
    stopPolling.current();
    await piCancelProviderLogin(endpointId, providerId);
    onOpenChange(false);
  };

  const device = deviceEvent(events);
  const linkEvent = events.find((event): event is Extract<PiLoginEvent, { type: 'auth_url' }> => event.type === 'auth_url');
  const progress = events.find((event) => event.type === 'progress' || event.type === 'info');

  const copyCode = async () => {
    if (!device) return;
    // `copyText`, never `navigator.clipboard` directly: over remote access (plain HTTP on a
    // Tailscale IP) `navigator.clipboard` is undefined, and only claiming "copied" when the copy
    // actually worked stops the button from lying.
    if (await copyText(device.userCode)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Only the explicit buttons close a pending flow.
        if (!next && !done && !error) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="w-[420px] sm:max-w-[420px]"
        onInteractOutside={(event) => {
          if (!done && !error) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (!done && !error) event.preventDefault();
        }}
      >
        <DialogHeader className="text-left">
          <DialogTitle>Sign in to {providerName}</DialogTitle>
          <DialogDescription>
            {done
              ? 'Signed in. Kiln saved the connection on its computer.'
              : error ? 'Sign-in did not finish. Use Try again below to start a new attempt.'
              : starting ? `Connecting to ${providerName}…`
              : question ? 'Finish signing in below. Kiln needs one thing from you to complete it.'
              : 'Open the sign-in page below and finish in your browser. Ember will notice when you’re done.'}
          </DialogDescription>
        </DialogHeader>

        {starting ? (
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Asking {providerName} how to sign in…
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {error}
          </p>
        ) : null}

        {done ? (
          <p className="flex items-center gap-1.5 text-[12.5px] text-success">
            <Check className="size-4" /> {providerName} is connected.
          </p>
        ) : null}

        {device && !done && !error ? (
          <div className="flex flex-col gap-3">
            <a
              href={device.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 self-start rounded-md border px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-muted"
            >
              {/* Never `new URL(...)` during render: a malformed URI from the host would throw and
                  take the dialog (and the tree around it) down. The helper degrades to the raw URI. */}
              Open {verificationHostLabel(device.verificationUri)}
              <ExternalLink className="size-3.5" />
            </a>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border bg-muted/50 px-3 py-2 text-center text-[18px] font-semibold tracking-[0.18em] tabular-nums">
                {device.userCode}
              </code>
              <Button type="button" variant="secondary" size="sm" onClick={() => void copyCode()} aria-label="Copy code">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              Enter that code on the page to approve this device.
              {device.expiresInSeconds
                ? ` The code expires in ${Math.round(device.expiresInSeconds / 60)} minutes.`
                : ''}
            </p>
            {providerId === 'openai-codex' ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">If OpenAI won’t accept the code</summary>
                <p className="mt-2">Enable device code login in your ChatGPT security settings, or ask your workspace admin to enable it. Then try again here.</p>
              </details>
            ) : null}
          </div>
        ) : null}

        {linkEvent && !device && !done && !error ? (
          <a
            href={linkEvent.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 self-start rounded-md border px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-muted"
          >
            Open sign-in page
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}

        {question && !done && !error ? (
          <form
            className="flex flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitAnswer();
            }}
          >
            {/* The host's own words: it knows what it is waiting for (the redirect URL, a code) and
                a paraphrase here would compete with the sentence the human is answering. */}
            <p className="text-[12.5px]">{question.message}</p>
            <div className="flex items-center gap-2">
              <input
                value={answerDraft}
                onChange={(event) => {
                  setAnswerDraft(event.target.value);
                  if (answerProblem) setAnswerProblem(null);
                }}
                placeholder={question.placeholder ?? 'Paste the URL from your browser’s address bar'}
                aria-label="Answer for the sign-in"
                autoComplete="off"
                autoFocus
                spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
              />
              <Button type="submit" size="sm" disabled={sendingAnswer || !answerDraft.trim()}>
                {sendingAnswer ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Send
              </Button>
            </div>
            {answerProblem ? (
              <p role="alert" className="text-[11.5px] text-destructive">
                {answerProblem}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Sign in in any browser. It will fail to load {signInAddressLabel(question.placeholder)} — copy
                the address bar and paste it here.
              </p>
            )}
          </form>
        ) : null}
        {progress && !done && !error ? (
          <p className="text-[11.5px] text-muted-foreground">
            {'message' in progress ? progress.message : null}
          </p>
        ) : null}

        {!done && !error && !starting && !question ? (
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground" aria-live="polite">
            <Loader2 className="size-3 animate-spin" /> {device ? 'Waiting for approval…' : 'Waiting for the browser to come back…'}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          {error ? <Button type="button" size="sm" onClick={() => setAttempt((value) => value + 1)}>Try again</Button> : null}
          {!done && !error ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void cancel()}>
              Cancel
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
