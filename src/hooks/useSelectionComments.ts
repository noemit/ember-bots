import * as React from 'react';
import type { ChatMessage, QuoteAnchor } from '@/types';
import { captureQuoteAnchor } from '@/lib/quoteLinks';
import { isCommentShortcut } from '@/lib/comments';

export type CommentBarPosition = { left: number; top: number };
type Options = {
  regionRef: React.RefObject<HTMLElement | null>;
  hostRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  sessionKey: string | null;
  messages: readonly ChatMessage[];
  hasDraft: boolean;
};

/** One retained source, independent of both the native selection and the main composer. */
export function useSelectionComments({ regionRef, hostRef, enabled, sessionKey, messages, hasDraft }: Options) {
  const [position, setPosition] = React.useState<CommentBarPosition | null>(null);
  const [anchor, setAnchor] = React.useState<QuoteAnchor | null>(null);
  const [quote, setQuote] = React.useState('');
  const [reason, setReason] = React.useState<string | null>(null);
  const editing = React.useRef(false);
  const pointerHeld = React.useRef(false);
  const focusRequested = React.useRef(false);
  const [focusEditor, setFocusEditor] = React.useState(false);
  const retained = React.useRef(hasDraft);
  retained.current = hasDraft;
  const dismiss = React.useCallback(() => {
    editing.current = false;
    focusRequested.current = false;
    setFocusEditor(false);
    setPosition(null);
    window.getSelection()?.removeAllRanges();
  }, []);
  const clearDraft = React.useCallback(() => {
    setAnchor(null); setQuote(''); setReason(null); dismiss();
  }, [dismiss]);
  const resume = React.useCallback(() => {
    editing.current = true;
    setFocusEditor(true);
    setPosition({ left: 8, top: Math.max(8, (hostRef.current?.clientHeight ?? 400) * 0.25) });
  }, [hostRef]);

  React.useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const capture = () => {
      // A keyboard request during a drag belongs to its final selection. Keep that intent
      // through selectionchange debounces and consume it only after the pointer is released.
      if (pointerHeld.current) return;
      const focus = focusRequested.current;
      if (retained.current) {
        // A retained draft keeps its original source. Honour the queued keyboard intent by
        // resuming it after release, rather than silently dropping the request or rebinding it.
        if (focus) { focusRequested.current = false; resume(); }
        return;
      }
      if (editing.current && !focus) return;
      focusRequested.current = false;
      // A pending shortcut must still focus an already-open empty editor. If the browser has a
      // final native range, the capture below also updates that empty editor to the final range.
      if (focus && editing.current) setFocusEditor(true);
      const selection = window.getSelection();
      const region = regionRef.current;
      const host = hostRef.current;
      if (!selection || selection.isCollapsed || !selection.rangeCount || !region || !host || !sessionKey) return;
      const range = selection.getRangeAt(0);
      if (!region.contains(range.commonAncestorContainer)) return;
      const node = range.commonAncestorContainer;
      const element = node instanceof Element ? node : node.parentElement;
      if (element?.closest('input, textarea, button, [contenteditable="true"]')) return;
      const rect = range.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const result = captureQuoteAnchor({ range, transcript: region, sessionKey, messages });
      setAnchor(result.ok ? result.anchor : null);
      setQuote(result.ok ? result.anchor.quote : selection.toString().trim());
      setReason(result.ok ? null : result.reason === 'multi-message'
        ? 'Select text within one message and one text block to annotate it.'
        : 'Ember cannot link this selection to an exact passage. Select a shorter passage in one plain-text block.');
      setPosition({ left: Math.max(8, Math.min(rect.left - hostRect.left, hostRect.width - 368)), top: rect.bottom - hostRect.top + 180 < hostRect.height ? rect.bottom - hostRect.top + 8 : Math.max(8, rect.top - hostRect.top - 180) });
      editing.current = true;
      // Native mouse selection stays selected until the person chooses the input. Only the
      // explicit keyboard shortcut and Resume transfer focus to the editor automatically.
      setFocusEditor(focus);
    };
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => capture(), 120); };
    const shortcut = (event: KeyboardEvent) => {
      if (!isCommentShortcut(event)) return;
      event.preventDefault();
      window.clearTimeout(timer);
      focusRequested.current = true;
      capture();
    };
    const outside = (event: PointerEvent) => {
      pointerHeld.current = event.button === 0 && Boolean(event.target instanceof Node && regionRef.current?.contains(event.target));
      if (!(event.target instanceof Element) || event.target.closest('[data-annotation-composer]')) return;
      if (editing.current) dismiss();
    };
    const release = () => { const selected = pointerHeld.current; pointerHeld.current = false; if (selected) schedule(); };
    const cancel = () => { pointerHeld.current = false; focusRequested.current = false; };
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('keydown', shortcut);
    document.addEventListener('pointerdown', outside);
    return () => { window.clearTimeout(timer); document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', cancel); document.removeEventListener('selectionchange', schedule); document.removeEventListener('keydown', shortcut); document.removeEventListener('pointerdown', outside); };
  }, [enabled, sessionKey, messages, regionRef, hostRef, dismiss, resume]);

  return { position, visible: Boolean(position), focusEditor, anchor, quote, reason, dismiss, resume, clearDraft };
}
