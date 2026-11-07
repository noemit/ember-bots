import * as React from 'react';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { piCancelProviderLogin, piPollProviderLogin, piStartProviderLogin, type PiLoginEvent } from '@/piApi';
import { copyText } from '@/lib/clipboard';
import { loginPollOutcome, verificationHostLabel } from '@/lib/providerLogin';

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
 * OAuth sign-in, driven by Hearth's device-code flow.
 *
 * The whole point is that the human finishes elsewhere (a browser, possibly on a phone), so this
 * dialog's job is to make the code easy to read and carry: clickable link, copyable code, and a
 * status that says plainly whether we are waiting, done, or failed. It deliberately does **not**
 * close on a backdrop click while a flow is pending — dismissing the dialog would abandon an
 * authentication the user is halfway through — so the only exits are Cancel and Close.
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

    void (async () => {
      const started = await piStartProviderLogin(endpointId, providerId);
      if (stopped) return;
      setStarting(false);
      if (!started.ok) {
        setError(started.error ?? 'Could not start signing in.');
        return;
      }
      if (started.state) setEvents(started.state.events ?? []);
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
        setEvents(polled.state?.events ?? []);
      }
    })();

    return () => {
      // Stop polling, but leave the flow running on the host: a StrictMode remount (or a re-render
      // path) must not cancel an authentication the user is completing in another window.
      // Only the explicit Cancel button ends it.
      stopped = true;
    };
  }, [open, endpointId, providerId, attempt]);

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
              : 'Open the sign-in page below and finish in your browser. Ember will notice when you’re done.'}
          </DialogDescription>
        </DialogHeader>

        {starting ? (
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Asking {providerName} for a code…
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

        {progress && !done && !error ? (
          <p className="text-[11.5px] text-muted-foreground">
            {'message' in progress ? progress.message : null}
          </p>
        ) : null}

        {!done && !error && !starting ? (
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground" aria-live="polite">
            <Loader2 className="size-3 animate-spin" /> Waiting for approval…
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
