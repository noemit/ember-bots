import * as React from 'react';
import { isCommentShortcut, normaliseSelection } from '@/lib/comments';

/**
 * Selecting text in the transcript raises a small bar near the selection (comment + quick
 * replies). The bar is anchored to a snapshot of the selection, so it is re-measured only when
 * the selection changes and hidden while the transcript scrolls under it.
 *
 * Keyboard: Mod+Alt+C comments on the current selection. It opens the bar's reply input, which is
 * the same first step a click takes, so nothing about the feature needs a mouse. The combination
 * avoids the composer's shortcuts (Mod+K, Mod+Enter, Mod+F, Mod+1-9); see `lib/comments.ts`.
 */

export type CommentBarPosition = { left: number; top: number };

type Options = {
  /** The element selections must fall inside (the transcript). */
  regionRef: React.RefObject<HTMLElement | null>;
  /** The element the bar is positioned within (the column, which is `relative`). */
  hostRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
};

/** Roughly the bar's width, so it can be centred over the selection without measuring twice. */
const BAR_WIDTH = 320;
/** Vertical gap between the selection and the bar, including the bar's own height. */
const BAR_OFFSET = 42;

export type SelectionComments = {
  position: CommentBarPosition | null;
  quote: string;
  /** True while the bar's reply input is open (clicking Comment or pressing the shortcut). */
  editing: boolean;
  openEditor: () => void;
  dismiss: () => void;
};

export function useSelectionComments({ regionRef, hostRef, enabled }: Options): SelectionComments {
  const [position, setPosition] = React.useState<CommentBarPosition | null>(null);
  const [quote, setQuote] = React.useState('');
  const [editing, setEditing] = React.useState(false);
  // While the reply input is focused the document selection collapses (focusing a field clears
  // it), which would otherwise hide the bar out from under the user mid-typing.
  const editingRef = React.useRef(false);
  const setEditingState = React.useCallback((next: boolean) => {
    editingRef.current = next;
    setEditing(next);
  }, []);

  const regionOf = React.useCallback(
    (node: Node): Element | null =>
      node instanceof Element ? node : node.parentElement ?? null,
    []
  );

  /** The selection's text and range, when it lives inside this column's transcript. */
  const readSelection = React.useCallback((): { quote: string; range: Range } | null => {
    const region = regionRef.current;
    const host = hostRef.current;
    const selection = window.getSelection();
    if (!region || !host || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!region.contains(range.commonAncestorContainer)) return null;
    // A selection inside a field belongs to that field; the bar would be in the way.
    if (regionOf(range.commonAncestorContainer)?.closest('input, textarea, [contenteditable="true"]')) {
      return null;
    }
    const text = normaliseSelection(selection.toString());
    if (!text) return null;
    return { quote: text, range };
  }, [hostRef, regionRef, regionOf]);

  const measure = React.useCallback(
    (range: Range): CommentBarPosition | null => {
      const host = hostRef.current;
      if (!host) return null;
      const rect = range.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      const maxLeft = Math.max(8, hostRect.width - BAR_WIDTH - 8);
      const left = Math.min(Math.max(rect.left + rect.width / 2 - BAR_WIDTH / 2, 8), maxLeft);
      const top = Math.max(rect.top - hostRect.top - BAR_OFFSET, 8);
      return { left: Math.round(left), top: Math.round(top) };
    },
    [hostRef]
  );

  const show = React.useCallback(
    (selection: { quote: string; range: Range }, editor: boolean): boolean => {
      const next = measure(selection.range);
      if (!next) return false;
      setQuote(selection.quote);
      setPosition(next);
      setEditingState(editor);
      return true;
    },
    [measure, setEditingState]
  );

  React.useEffect(() => {
    if (!enabled) {
      setPosition(null);
      setQuote('');
      setEditingState(false);
      return;
    }
    let timer: number | undefined;
    const update = () => {
      if (editingRef.current) return;
      const selection = readSelection();
      if (!selection) {
        setPosition(null);
        setQuote('');
        return;
      }
      // Opens *in* the reply box, not on a preview with a Comment button beside it. Selecting text
      // is already the intent to annotate it; making the person press Comment first was a second
      // confirmation of something they had just done. `editing=true` also stops this effect from
      // hiding the bar when focusing the field collapses the document selection.
      show(selection, true);
    };
    const schedule = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      // Selections settle a frame after the pointer is released; a short debounce reads it once.
      timer = window.setTimeout(update, 120);
    };
    document.addEventListener('selectionchange', schedule);
    const region = regionRef.current;
    const onScroll = () => {
      if (editingRef.current) return;
      setPosition(null);
      setQuote('');
    };
    region?.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('selectionchange', schedule);
      region?.removeEventListener('scroll', onScroll, true);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, readSelection, regionRef, setEditingState, show]);

  React.useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCommentShortcut(event)) return;
      const selection = readSelection();
      if (!selection) return;
      event.preventDefault();
      show(selection, true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, readSelection, show]);

  const dismiss = React.useCallback(() => {
    setPosition(null);
    setQuote('');
    setEditingState(false);
    // The comment now owns the quote, so the highlight that produced it can go.
    window.getSelection()?.removeAllRanges();
  }, [setEditingState]);

  const openEditor = React.useCallback(() => setEditingState(true), [setEditingState]);

  return { position, quote, editing, openEditor, dismiss };
}
