import * as React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type AutoResizeTextareaProps = Omit<React.ComponentProps<typeof Textarea>, 'onHeightChange'> & {
  /** The tallest the box may grow before it starts scrolling. */
  maxHeight?: number;
  /**
   * Where a dragged resize settled, in pixels, or `null` for "size itself to the text".
   *
   * Owned by the caller because it has to survive the component: the height persists as a draft, and
   * it must be readable when deciding whether the reader chose it (see `onHeightChange`).
   */
  manualHeight?: number | null;
  /** Called when the reader drags the handle. `null` means they dragged it back to automatic. */
  onHeightChange?: (height: number | null) => void;
  /**
   * The tallest a *dragged* height may be. Separate from `maxHeight`, which is where automatic
   * growth stops: dragging is an explicit request to see more, so it may go past the cap — but not
   * past the window.
   */
  maxManualHeight?: number;
  /** Off for a field where a drag would be noise (the comment reply inside a scrollable tray). */
  resizable?: boolean;
};

/** How tall the box is when it has nothing to show; matches `min-h-9` below. */
const MIN_HEIGHT = 36;
/** A drag has to move this far past the automatic height before it counts as deliberate. */
const DRAG_SLOP = 4;

/**
 * What the box would be if it sized itself: the text's height, capped.
 *
 * A module-level function rather than a closure so the layout effect has nothing to depend on
 * beyond `value`, `maxHeight` and `manualHeight` — a helper redefined each render would be a new
 * dependency every time, which is how the composer could re-measure in a loop.
 */
const naturalHeight = (textarea: HTMLTextAreaElement, maxHeight: number): number => {
  const previous = textarea.style.height;
  textarea.style.height = 'auto';
  const natural = textarea.scrollHeight;
  textarea.style.height = previous;
  return Math.min(natural, maxHeight);
};

/**
 * A textarea that grows with its text, scrolls once it reaches `maxHeight`, and can be dragged.
 *
 * Three things this had to get right, each of which was a reported bug:
 *
 * - **A scrollbar appears when it is full.** The old version set `overflow-hidden` unconditionally,
 *   so a pasted wall of text was silently clipped at 160px with no way to see the rest and no sign
 *   that there *was* a rest. Overflow is now `auto`, and only below the cap.
 * - **Dragging actually resizes.** The height came from `Math.min(scrollHeight, maxHeight)`, so a
 *   dragged height was overwritten on the next render — the handle moved and the box snapped back.
 *   A dragged height now wins, until the reader drags it back to automatic.
 * - **The handle is visible.** `resize-none` was inherited from the shadcn `Textarea`, so there was
 *   nothing to grab; only the browser's native corner grip is used, because a custom one would
 *   need pointer maths to re-implement something the OS already does well.
 */
export const AutoResizeTextarea = React.forwardRef<HTMLTextAreaElement, AutoResizeTextareaProps>(
  (
    {
      maxHeight = 160,
      maxManualHeight,
      manualHeight = null,
      onHeightChange,
      className,
      onChange,
      value,
      resizable = true,
      ...props
    },
    forwardedRef
  ) => {
    const internalRef = React.useRef<HTMLTextAreaElement>(null);
    const mergedRef = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        internalRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
      },
      [forwardedRef]
    );

    React.useLayoutEffect(() => {
      const textarea = internalRef.current;
      if (!textarea) return;
      // A dragged height is a decision, not a measurement: it stays until the reader resets it, even
      // as they type. Clamped to the cap so a drag cannot push the composer off the screen.
      // A dragged height is NOT capped by `maxHeight`: that cap is where *automatic* growth stops,
      // and clamping the manual value to it made the handle impossible to drag past — the box
      // snapped back to 320 the moment the reader let go. The only ceiling is the window, below.
      const ceiling = maxManualHeight ?? maxHeight;
      const target = manualHeight === null ? naturalHeight(textarea, maxHeight) : Math.min(ceiling, Math.max(MIN_HEIGHT, manualHeight));
      textarea.style.height = `${target}px`;
      // Scrolling exactly when the content exceeds what is shown, so the bar appears the moment it
      // is needed and never floats over a box that fits.
      textarea.style.overflowY = textarea.scrollHeight > target + 1 ? 'auto' : 'hidden';
    }, [value, maxHeight, maxManualHeight, manualHeight]);

    /**
     * Dragging the handle.
     *
     * `pointerup` is not enough on its own: dragging the box *smaller* than its automatic height
     * makes the text overflow, so the only way back to "grow with the text" is to drag past it —
     * which is what the slop below means, and why `null` is reachable at all.
     */
    const onPointerUp = (event: React.PointerEvent<HTMLTextAreaElement>) => {
      if (!onHeightChange) return;
      const textarea = event.currentTarget;
      const natural = naturalHeight(textarea, maxHeight);
      const current = textarea.getBoundingClientRect().height;
      // Back to automatic when the drag lands at (or above) the height the text wants anyway: there
      // is no visible difference, so keeping a "manual" value would only mean the box stops growing
      // the next time more text arrives, for no reason the reader could see.
      onHeightChange(current <= natural + DRAG_SLOP ? null : Math.round(current));
    };

    return (
      <Textarea
        ref={mergedRef}
        value={value}
        onChange={onChange}
        onPointerUp={onPointerUp}
        // `field-sizing` is left off deliberately: the height is set imperatively, and letting CSS
        // size it too makes the two disagree on the frame after a paste.
        className={cn(
          'min-h-9 py-2',
          // The scrollbar is the composer's own, not the page's: a themed thin bar that appears only
          // when the box is full, so a long paste reads as scrollable instead of looking clipped.
          '[scrollbar-width:thin] [scrollbar-color:var(--border)_transparent]',
          resizable ? 'resize-y' : 'resize-none',
          className
        )}
        style={{ height: 'auto' }}
        {...props}
      />
    );
  }
);
AutoResizeTextarea.displayName = 'AutoResizeTextarea';
