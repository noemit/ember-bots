import * as React from 'react';
import { questionDrafts } from '../lib/asyncQuestionDrafts';
import { composerMemory } from '../lib/composerDrafts';
import { copyText } from '../lib/clipboard';
import { isRemoteExpired, remoteAuxiliaryDrafts, remoteUnsentText, reportRemoteConnection } from '../lib/remoteLifecycle';
import { clearRemoteShell } from '../lib/remoteShell';

export const hasUnsentRemoteDraft = () => Boolean(remoteUnsentText()) || questionDrafts.hasUnsent() || [...composerMemory.values()].some((draft) =>
  Boolean(draft.text.trim() || draft.attachments.length || draft.replyContext));

/** Remote-only chrome; never promises background execution or deferred delivery. */
export function RemoteAppStatus() {
  const [state, setState] = React.useState(isRemoteExpired() ? 'expired' : navigator.onLine ? 'online' : 'offline');
  const [help, setHelp] = React.useState(false);
  const [waiting, setWaiting] = React.useState<ServiceWorker | null>(null);
  const [updateReady, setUpdateReady] = React.useState(false);
  const [blocked, setBlocked] = React.useState(false);
  const secure = window.isSecureContext;
  const recoveryHeading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (state !== 'expired') return;
    const frame = requestAnimationFrame(() => recoveryHeading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [state]);

  React.useEffect(() => {
    const connection = (event: Event) => setState((current) => current === 'expired' ? current : (event as CustomEvent<{ state: string }>).detail.state);
    const offline = () => setState((current) => current === 'expired' || isRemoteExpired() ? 'expired' : 'offline');
    const expired = () => {
      document.body.dataset.remoteExpired = 'true';
      setState('expired');
      void clearRemoteShell().catch(() => {});
    };
    window.addEventListener('ember:remote-connection', connection);
    window.addEventListener('offline', offline);
    window.addEventListener('ember:session-expired', expired);
    let disposed = false;
    if (secure && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((registration) => {
        if (disposed) return;
        if (registration.waiting) setWaiting(registration.waiting);
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (!disposed && worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(registration.waiting);
          });
        });
      }).catch(() => { /* Browser UI still works when installation is unavailable. */ });
    }
    return () => {
      disposed = true;
      window.removeEventListener('ember:remote-connection', connection);
      window.removeEventListener('offline', offline);
      window.removeEventListener('ember:session-expired', expired);
    };
  }, [secure]);

  const refresh = () => {
    // App's lifecycle guard also covers active turns, in-flight sends and queued delivery.
    const check = new CustomEvent('ember:can-reload', { cancelable: true });
    if (hasUnsentRemoteDraft() || !window.dispatchEvent(check)) { setBlocked(true); return; }
    if (waiting && !updateReady) {
      waiting.addEventListener('statechange', () => {
        if (waiting.state === 'activated') { setUpdateReady(true); setWaiting(null); }
      });
      waiting.postMessage('ACTIVATE_UPDATE');
      // Activation never reloads a page. The reader decides again once activation finishes.
      return;
    }
    window.location.reload();
  };

  const signOut = async () => {
    if (hasUnsentRemoteDraft() && !window.confirm('Signing out leaves unsent drafts and attachments behind. Copy anything you need before signing out. Continue?')) return;
    try {
      const response = await fetch('/remote/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) { setState((current) => current === 'expired' || isRemoteExpired() ? 'expired' : 'unavailable'); return; }
      await clearRemoteShell().catch(() => {});
      composerMemory.clear();
      questionDrafts.clear();
      remoteAuxiliaryDrafts.clear();
      reportRemoteConnection('expired');
      window.dispatchEvent(new CustomEvent('ember:session-expired'));
      window.location.assign('/remote/login');
    } catch { setState((current) => current === 'expired' || isRemoteExpired() ? 'expired' : 'unavailable'); }
  };

  if (state === 'expired') return <section className="remote-auth-cover" role="alert">
    <h1 ref={recoveryHeading} tabIndex={-1}>Sign in to Ember again</h1>
    <p>Ember ended this session. Conversations are hidden. Unsent drafts remain here until you leave this page; attachments cannot be recovered after leaving.</p>
    <button onClick={() => void copyText(remoteUnsentText())}>Copy unsent text</button>
    <button onClick={() => window.location.assign('/remote/login')}>Go to sign in</button>
  </section>;

  return <aside className="remote-app-status" aria-label="Remote app">
    {state !== 'online' && <p role="status">{state === 'offline' ? 'This phone is offline.' : 'The Ember computer is not answering.'} Keep this app open to preserve unsent drafts and attachments. Unsent drafts are not uploaded automatically; messages already accepted by the host may still run. Check your private connection and that Ember is running.</p>}
    {(waiting || updateReady) && <div><button onClick={refresh}>{updateReady ? 'Refresh to use update' : 'Prepare update'}</button><span> Your workspace will not refresh automatically.</span></div>}
    {blocked && <p role="status">Keep working for now. Finish active turns and resolve pending sends; send, save or copy drafts and remove attachments before refreshing.</p>}
    <button aria-expanded={help} onClick={() => setHelp(!help)}>Phone app</button>
    {help && <div className="remote-app-help">
      <p>{secure ? 'iPhone: open this private HTTPS address in Safari, then Share → Add to Home Screen. Android: use Chrome’s menu → Install app or Add to Home screen.' : 'This address uses HTTP. Browsing still works, but installation needs the private HTTPS address configured on the Ember computer. See Settings → Remote access on that computer.'}</p>
      <p>Keep the Ember computer running and reachable over your private network. No offline conversations, sending, background sync or notifications. Unsent drafts and attachments stay in this open app; offline changes are not guaranteed after closing it.</p>
      <button onClick={() => void signOut()}>Sign out</button>
    </div>}
  </aside>;
}
