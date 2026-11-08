import * as React from 'react';
import { EyeOff, Plus } from 'lucide-react';
import Blob from '../blob/Blob';
import { useAvatarSize } from '../blob/size';
import type { AvatarIdentity, BallMood, BlobStyle } from '../types';

/** The destination stays beside the message, even when its conversation header is far away. */
export default function ComposerIdentity({ name, seed, identity, style, mood, docked = false, compact = false, directory, topMeta, onRename, avatarOverlay, onHide, onNewBot, hiding = false, showAvatar = true }: {
  name: string;
  seed: string;
  identity: AvatarIdentity;
  style: BlobStyle;
  mood: BallMood;
  docked?: boolean;
  compact?: boolean;
  directory?: string;
  topMeta?: React.ReactNode;
  onRename?: (title: string) => void;
  avatarOverlay?: React.ReactNode;
  onHide?: () => void;
  onNewBot?: () => void;
  hiding?: boolean;
  /** Unpromoted threads keep their name but have no bot identity yet. */
  showAvatar?: boolean;
}) {
  const size = useAvatarSize(docked ? (compact ? 40 : 55) : 32);
  const [editing, setEditing] = React.useState(false);
  const cancelled = React.useRef(false);
  const folder = directory?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return <div data-composer-identity className={docked ? (compact ? "group/identity relative flex min-w-0 items-center justify-center px-1 py-2" : "group/identity flex min-w-0 items-center gap-3 px-4 py-3") : "group/identity flex min-w-0 items-center gap-2 px-3 pt-2 pb-[3px]"}>
    {showAvatar ? <span className="relative inline-flex flex-none"><Blob style={style} seed={seed} identity={identity} size={size} mood={mood} />{avatarOverlay}</span> : null}
    {!compact ? <div className="min-w-0 flex-1">
      {docked && topMeta ? <span data-composer-context className="mb-1 flex min-w-0 items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground">{topMeta}</span> : null}
      {editing ? <input autoFocus aria-label="Rename session" defaultValue={name} className="w-full min-w-0 rounded border bg-background px-1 py-0.5 text-[13px]"
        onKeyDown={event => { if (event.key === 'Escape') { cancelled.current = true; setEditing(false); } else if (event.key === 'Enter') event.currentTarget.blur(); }}
        onBlur={event => { const title = event.currentTarget.value.trim(); if (!cancelled.current && title && title !== name) onRename?.(title); setEditing(false); }} />
        : <span className="block truncate text-[13px] font-medium text-foreground" title={onRename ? `${name} — double-click to rename` : name}
          onDoubleClick={onRename ? () => { cancelled.current = false; setEditing(true); } : undefined}>{name}</span>}
      {docked && !topMeta && folder ? <span className="mt-1 block truncate text-[11px] text-muted-foreground" title={directory}>{folder}</span> : null}
    </div> : null}
    {onNewBot || onHide ? <div data-composer-identity-actions className={`flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/identity:opacity-100 group-focus-within/identity:opacity-100 group-focus-within/dock:opacity-100 [@media(hover:none)]:opacity-100${compact ? ' absolute top-[calc(100%-8px)]' : ''}`}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      {onNewBot ? <button type="button" aria-label="New bot in this folder" title="New bot in this folder"
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onNewBot}><Plus size={15} aria-hidden="true" /></button> : null}
      {onHide ? <button type="button" aria-label="Hide session" title={hiding ? 'Hiding session…' : 'Hide session'} disabled={hiding}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
        onClick={onHide}><EyeOff size={15} aria-hidden="true" /></button> : null}
    </div> : null}
  </div>;
}
