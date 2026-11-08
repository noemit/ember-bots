import * as React from 'react';
import { Check, Copy, Eye, EyeOff, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { copyText } from '@/lib/clipboard';
import { useStableCallback } from '@/lib/useStableCallback';
import type { LocalHarnessToken } from '../types';

type Props = {
  /**
   * Whether this app started the harness on this computer (`started`, not `attached`). Only then can
   * it give the harness a new token: an attached host's lifecycle belongs to whatever started it.
   */
  canRotate: boolean;
  /** The bridge method; absent on an older bridge and on the web mock. */
  loadToken?: (options?: { rotate?: boolean }) => Promise<LocalHarnessToken>;
  /** Ask App to reprobe, because a rotation restarts the host and changes nothing else. */
  onRefreshInstances?: () => void;
};

const MASK = '••••••••';

/**
 * The credential for the harness running on this computer.
 *
 * It exists because the token was previously only reachable by opening `~/.ember/hearth.token` in a
 * text editor or running `tinder token` — for a value whose entire job is being copied to another
 * machine. The app that owns the harness should be the place you get it.
 *
 * Three rules shape it:
 *
 * - **Masked until asked.** This panel is the most screenshot-prone surface in the app, and a token
 *   pasted into a bug report is a leaked credential. Copy works without revealing.
 * - **Regenerating is one operation, not two.** A token is read by the harness at startup, so writing
 *   the file under a running process would show a new token while it still accepted the old one. Main
 *   stops it, writes, restarts — see `ember:local-harness-token` — and this screen only reports it.
 * - **Say who is affected.** A new token breaks every other machine and browser pointed at this host,
 *   and that has to be in the sentence the person reads before they click.
 */
export default function LocalTokenSettings({ canRotate, loadToken, onRefreshInstances }: Props) {
  const [state, setState] = React.useState<LocalHarnessToken | null>(null);
  const [revealed, setRevealed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState<'load' | 'rotate' | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Pin `loadToken` so an unstable function identity from the parent (`.bind()`, an inline arrow)
  // can never re-trigger the initial read on every parent render — that was the bug where the row
  // flashed nonstop between `••••••••` and "Reading it from the harness…".
  const hasLoadToken = Boolean(loadToken);
  const runLoadToken = useStableCallback(
    (options?: { rotate?: boolean }): Promise<LocalHarnessToken> => {
      if (!loadToken) return Promise.reject(new Error('loadToken is unavailable'));
      return loadToken(options);
    }
  );

  React.useEffect(() => {
    if (!hasLoadToken) return;
    let cancelled = false;
    setBusy('load');
    void runLoadToken()
      .then((answer) => {
        if (cancelled) return;
        setState(answer);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Ember couldn't read the token from the harness on this computer.");
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hasLoadToken, runLoadToken]);

  const copy = async () => {
    if (!state?.token) return;
    const ok = await copyText(state.token);
    if (!ok) {
      // The clipboard refused and the fallback failed too: show it instead of claiming success, so
      // the person can select it by hand.
      setRevealed(true);
      setError('The clipboard refused the copy. The token is shown below — select it and copy by hand.');
      return;
    }
    setError(null);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  const rotate = async () => {
    if (!hasLoadToken) return;
    setConfirming(false);
    setBusy('rotate');
    setError(null);
    try {
      const answer = await runLoadToken({ rotate: true });
      setState(answer);
      setRevealed(true);
      if (!answer.ok) setError(answer.reason ?? "The harness didn't accept a new token.");
      else onRefreshInstances?.();
    } catch (err) {
      setError(
        err instanceof Error
          ? `Ember couldn't give the harness a new token: ${err.message}`
          : "Ember couldn't give the harness a new token."
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="local-harness-token">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Token</span>
        {state?.url ? <span className="truncate text-[11px] text-muted-foreground">{state.url}</span> : null}
      </div>

      {busy === 'load' && !state ? (
        <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Reading it from the harness…
        </span>
      ) : state?.token ? (
        <>
          <div className="flex items-center gap-1.5">
            <code
              className="min-w-0 flex-1 truncate rounded-md border bg-muted/30 px-2 py-1.5 text-[12px] tabular-nums"
              title={revealed ? state.token : undefined}
              data-revealed={revealed ? 'true' : 'false'}
            >
              {revealed ? state.token : MASK}
            </code>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => setRevealed((prev) => !prev)}
              aria-label={revealed ? 'Hide the token' : 'Show the token'}
              aria-pressed={revealed}
            >
              {revealed ? <EyeOff /> : <Eye />}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => void copy()}
              aria-label="Copy the token"
              data-copied={copied ? 'true' : 'false'}
            >
              {copied ? <Check className="text-success" /> : <Copy />}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Other machines and browsers use this to connect to this one. Anyone who has it can use this
            computer's bots, so treat it like a password.
          </p>
          {canRotate ? (
            confirming ? (
              <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5">
                <span className="flex items-start gap-1.5 text-[11.5px]">
                  <ShieldAlert className="mt-px size-3.5 flex-none text-destructive" />
                  <span>
                    Every other machine and browser pointed at this host will stop connecting until
                    you copy the new token across. The bots themselves are untouched.
                  </span>
                </span>
                <div className="flex items-center gap-1.5">
                  <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                    Keep it
                  </Button>
                  <div className="flex-1" />
                  <Button size="xs" variant="destructive" onClick={() => void rotate()}>
                    New token
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setConfirming(true)}
                  disabled={busy !== null}
                  data-testid="rotate-token"
                >
                  {busy === 'rotate' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {busy === 'rotate' ? 'Restarting the harness…' : 'New token'}
                </Button>
              </div>
            )
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Ember didn't start this harness, so it can't give it a new token. Restart the harness
              yourself and it keeps the token it already has.
            </p>
          )}
        </>
      ) : (
        <p className="text-[11.5px] text-muted-foreground">
          {state?.reason ??
            "There's no token to show: this build doesn't know about a harness on this computer."}
        </p>
      )}

      {error ? (
        <p className={cn('text-[11.5px] text-destructive')} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
