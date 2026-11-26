import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import UpdateCheckSummary from './UpdateCheckSummary';
import type { UpdateSnapshot } from '../types';

const releases = 'https://github.com/noemit/ember-bots/releases';

function updateCopy(state: UpdateSnapshot): string {
  switch (state.phase) {
    case 'disabled': return state.message || 'Ember updates are disabled in development and Canary builds. Use a stable installed build for desktop updates.';
    case 'checking': return 'Ember is checking for a stable update…';
    case 'available': return `Ember ${state.version ?? 'update'} is available. Download it when you’re ready.`;
    case 'downloading': return 'Ember is downloading the update. You can keep working.';
    case 'downloaded': return 'Ember’s update is ready. It will install only when you choose Restart and install, not when you quit.';
    case 'error': return state.message ? `Ember couldn’t finish the update. ${state.message} Use Retry below or open Releases.` : 'Ember couldn’t finish the update. Use Retry below or open Releases to download it manually.';
    case 'idle': return state.supported ? 'Ember is ready to check for stable updates. Downloads start only when you choose.' : 'Ember cannot install updates on this platform. Open Releases to download and install the latest version manually.';
  }
}

/** The desktop owns discovery and installation. Rendering this never starts a network check. */
export default function DesktopUpdates({ placement = 'toolbar' }: { placement?: 'toolbar' | 'settings' }) {
  const enabled = window.ember.capabilities?.desktopUpdates === true;
  const [snapshot, setSnapshot] = React.useState<UpdateSnapshot | null>(null);
  const [open, setOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [checked, setChecked] = React.useState(false);
  const revision = React.useRef(0);

  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    const received = () => { revision.current += 1; };
    const unsubscribe = window.ember.onUpdateState?.((state) => {
      received();
      if (active) setSnapshot(state);
    });
    const started = revision.current;
    void Promise.resolve(window.ember.getUpdateState?.()).then((state) => {
      // Main may still be starting when the first window asks. Leave a recoverable state,
      // rather than a permanent loading dialog; later desktop broadcasts replace it.
      if (!state) throw new Error('Desktop updater is still starting');
      if (active && revision.current === started) setSnapshot(state);
    }).catch(() => {
      if (active && revision.current === started) setSnapshot({ phase: 'error', currentVersion: '', supported: true });
    });
    return () => { active = false; unsubscribe?.(); };
  }, [enabled]);

  const act = async (action: 'check' | 'download' | 'restart') => {
    if (pending || !window.ember.updateAction) return;
    setPending(true);
    const started = revision.current;
    try {
      const state = await window.ember.updateAction(action);
      if (!state) throw new Error('Desktop updater is still starting');
      if (revision.current === started) setSnapshot(state);
      if (action === 'check') setChecked(true);
    } catch {
      if (revision.current === started) setSnapshot((state) => ({ currentVersion: state?.currentVersion ?? '', version: state?.version, supported: state?.supported ?? true, phase: 'error' }));
    } finally {
      setPending(false);
    }
  };
  if (!enabled) return null;
  const attention = snapshot && (['available', 'downloading', 'downloaded'].includes(snapshot.phase) || (snapshot.phase === 'error' && Boolean(snapshot.version)));
  const label = snapshot?.phase === 'available' ? 'Update available' : snapshot?.phase === 'downloaded' ? 'Update ready' : snapshot?.phase === 'downloading' ? 'Downloading update' : snapshot?.phase === 'error' ? 'Update needs attention' : 'Check for updates';
  const busy = pending || snapshot?.phase === 'checking' || snapshot?.phase === 'downloading';
  const progress = typeof snapshot?.progress === 'number' && Number.isFinite(snapshot.progress) ? Math.round(Math.max(0, Math.min(100, snapshot.progress))) : undefined;
  const requestRestart = () => { setConfirm(true); };

  return <>
    {placement === 'settings' ? <div className="space-y-3">
      <UpdateCheckSummary snapshot={snapshot} />
      <div className="flex flex-wrap items-center gap-2">
        {snapshot?.supported && snapshot.phase !== 'disabled' ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { void act('check'); }}>{snapshot.phase === 'downloading' ? 'Downloading…' : busy ? 'Checking…' : 'Check now'}</Button> : <p className="text-xs text-muted-foreground">{snapshot ? updateCopy(snapshot) : null}</p>}
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Update details</Button>
        {attention ? <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{label}</Button> : null}
        {snapshot && !snapshot.supported ? <Button size="sm" variant="outline" onClick={() => void window.ember.openExternal(releases)}>Open Releases</Button> : null}
      </div>
    </div> : attention ? <button type="button" className={`no-drag shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] focus-visible:outline-2 focus-visible:outline-ring ${attention ? 'border-highlight/40 text-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`${label}${snapshot?.phase === 'downloading' && progress !== undefined ? ` · ${progress}%` : ''}`}>
      <span role="status">{label}{snapshot?.phase === 'downloading' && progress !== undefined ? ` · ${progress}%` : ''}</span>
    </button> : null}
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) setConfirm(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirm ? 'Restart Ember and install?' : 'Ember updates'}</DialogTitle>
          <DialogDescription>{confirm
            ? 'Restarting Ember stops its bundled Kiln, including running chats and tasks. Wait for that work to finish before restarting. Standalone Kilns, including Tinder-managed Kilns, keep running. Ember will not send an abort command.'
            : snapshot ? updateCopy(snapshot) : 'Ember is reading the desktop update status…'}</DialogDescription>
        </DialogHeader>
        {!confirm && snapshot && <div className="space-y-3 text-sm">
          {snapshot.currentVersion && <p className="text-muted-foreground">Installed: Ember {snapshot.currentVersion}</p>}
          {snapshot.phase === 'idle' && checked && snapshot.supported && <p role="status">Ember found no newer stable update.</p>}
          {snapshot.phase === 'downloading' && <div role="progressbar" aria-label="Ember update download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-2 overflow-hidden rounded bg-muted"><div className="h-full bg-highlight" style={{ width: progress === undefined ? '0%' : `${progress}%` }} /></div>}
        </div>}
        <DialogFooter>
          {confirm ? <>
            <Button variant="secondary" disabled={pending} onClick={() => setConfirm(false)} autoFocus>Keep working</Button>
            <Button disabled={pending} onClick={() => { setConfirm(false); void act('restart'); }}>Restart and install</Button>
          </> : <>
            <Button variant="secondary" onClick={() => void window.ember.openExternal(releases)}>Open Releases</Button>
            {snapshot?.supported && snapshot.phase !== 'disabled' && window.ember.updateAction && <>
              {snapshot.phase === 'available' ? <Button disabled={busy} onClick={() => void act('download')}>Download update</Button>
                : snapshot.phase === 'downloaded' ? <Button disabled={busy} onClick={requestRestart}>Restart and install</Button>
                : snapshot.phase === 'error' ? <Button disabled={busy} onClick={() => void act(snapshot.version ? 'download' : 'check')}>Retry</Button>
                : <Button disabled={busy} onClick={() => void act('check')}>{snapshot.phase === 'checking' ? 'Checking…' : snapshot.phase === 'downloading' ? 'Downloading…' : 'Check for updates'}</Button>}
            </>}
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
