import * as React from 'react';
import { Dialog } from 'radix-ui';
import { ChevronLeft, ChevronRight, Download, Minus, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  MAX_SCALE,
  MIN_SCALE,
  neighborIndex,
  type ImageView,
  type ViewerImage,
} from '@/lib/gallery';

type Props = {
  images: ViewerImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
};

/** A view where `scale` multiplies the image's *natural* pixels, not its fitted box. */
const FIT_VIEW: ImageView = { scale: 1, x: 0, y: 0 };

/**
 * The image lightbox.
 *
 * Two things this has to get right, because getting them wrong is what makes a viewer feel
 * unpredictable:
 *
 * 1. **"100%" has to mean one image pixel per screen pixel.** The image is laid out with
 *    `max-h-full max-w-full`, so a large screenshot is already shrunk before any transform. A raw
 *    `scale: 1` therefore means "fitted to this window", not "actual size", and the same number
 *    read differently depending on how big the window was. `fitScale` is the ratio between the
 *    fitted box and the natural size; every percentage shown is `scale * fitScale`, so 100% is
 *    the image's real size at every window size.
 * 2. **Clicking the backdrop closes, reliably.** The old handler sat on the outer column, but the
 *    image surface is a child that fills it, so a click almost never reached the element carrying
 *    the handler. The surface handles it now, and only when it is a click rather than the end of
 *    a pan.
 */
export default function ImageViewer({ images, index, onIndex, onClose }: Props) {
  const [view, setView] = React.useState<ImageView>(FIT_VIEW);
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = React.useState<{ w: number; h: number } | null>(null);
  const [surface, setSurface] = React.useState<HTMLDivElement | null>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const movedRef = React.useRef(false);
  /** True for the gesture that captured the pointer, so its click is not read as a backdrop hit. */
  const capturedRef = React.useRef(false);
  const image = images[index] ?? images[0];

  // Fit on a new image; a closed viewer leaves nothing behind.
  React.useEffect(() => {
    setView(FIT_VIEW);
    setNatural(null);
  }, [index, image?.id]);

  // This viewer is opened imperatively, without a Dialog.Trigger. Restore its originating
  // image button (including one inside a worker dialog) when the topmost modal closes.
  const [returnFocus] = React.useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);

  /**
   * The ratio between the fitted box and the image's natural size. `>= 1` means the image is small
   * enough to be shown at full size already; `< 1` means the browser shrank it to fit.
   */
  const fitScale = React.useMemo(() => {
    if (!natural || !box || !natural.w || !natural.h) return 1;
    return Math.min(box.w / natural.w, box.h / natural.h, 1);
  }, [natural, box]);

  // Track the available surface so fitScale follows the window.
  React.useEffect(() => {
    const el = surface;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [surface]);

  /** Zoom while holding the point under the pointer still. */
  const zoomAt = React.useCallback((pointerX: number, pointerY: number, rawScale: number) => {
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, rawScale));
      if (scale === current.scale) return current;
      if (scale === MIN_SCALE) return FIT_VIEW;
      const ratio = scale / current.scale;
      return {
        scale,
        x: pointerX - (pointerX - current.x) * ratio,
        y: pointerY - (pointerY - current.y) * ratio,
      };
    });
  }, []);

  const zoomTo = React.useCallback(
    (next: number) => {
      const el = surface;
      const cx = el ? (el.clientWidth / 2 - view.x) / view.scale : 0;
      const cy = el ? (el.clientHeight / 2 - view.y) / view.scale : 0;
      zoomAt(cx, cy, next);
    },
    [surface, view.x, view.y, view.scale, zoomAt]
  );

  // Scope navigation and zoom to this focus-trapped dialog. Escape belongs to Radix's
  // topmost dismissable layer, so it never closes the worker dialog underneath as well.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowLeft' && images.length > 1) {
      event.preventDefault();
      onIndex(neighborIndex(images.length, index, -1));
    } else if (event.key === 'ArrowRight' && images.length > 1) {
      event.preventDefault();
      onIndex(neighborIndex(images.length, index, 1));
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomTo(view.scale * 1.25);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomTo(view.scale / 1.25);
    } else if (event.key === '0') {
      event.preventDefault();
      setView(FIT_VIEW);
    } else if (event.key === '1') {
      event.preventDefault();
      zoomTo(1 / (fitScale || 1));
    }
  };

  /** The percentage a person should see: 100% is the image's actual pixel size. */
  const actualPercent = Math.round(view.scale * fitScale * 100);
  const atFit = view.scale === 1;
  /** True at 1:1 with the image's own pixels. */
  const atActual = Math.abs(view.scale * fitScale - 1) < 0.005;

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
    <Dialog.Content
      ref={contentRef}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        contentRef.current?.focus();
      }}
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm"
      aria-describedby={undefined}
      onKeyDown={onKeyDown}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (returnFocus?.isConnected) returnFocus.focus();
      }}
      aria-label={`Image: ${image.filename}`}
    >
      <Dialog.Title className="sr-only">Image: {image.filename}</Dialog.Title>
      <div className="flex flex-none items-center gap-2 px-3 py-2 text-white/90">
        <span className="min-w-0 flex-1 truncate text-[12.5px]" title={image.filename}>
          {image.filename}
          {image.tool ? <span className="text-white/50"> · {image.tool}</span> : null}
        </span>
        {images.length > 1 ? (
          <span className="tabular-nums text-[11.5px] text-white/70" aria-live="polite">
            {index + 1} / {images.length}
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-white/80 hover:bg-white/10 hover:text-white"
          aria-label="Zoom out"
          title="Zoom out (−)"
          disabled={atFit}
          onClick={() => zoomTo(view.scale / 1.25)}
        >
          <Minus className="size-4" />
        </Button>
        {/* The readout is a button: it snaps back to actual size from wherever you are. */}
        <button
          type="button"
          onClick={() => zoomTo(1 / (fitScale || 1))}
          title={atActual ? 'Showing actual size' : 'Click for actual size (1:1)'}
          aria-label={`Zoom level ${actualPercent} percent. Click for actual size.`}
          className="min-w-[52px] rounded px-1.5 py-0.5 text-center tabular-nums text-[11.5px] text-white/80 hover:bg-white/10 hover:text-white"
        >
          {actualPercent}%
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-white/80 hover:bg-white/10 hover:text-white"
          aria-label="Zoom in"
          title="Zoom in (+)"
          disabled={view.scale >= MAX_SCALE}
          onClick={() => zoomTo(view.scale * 1.25)}
        >
          <Plus className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn('text-white/80 hover:bg-white/10 hover:text-white', atFit && 'text-white')}
          aria-pressed={atFit}
          title="Shrink to fit the window (0)"
          onClick={() => setView(FIT_VIEW)}
        >
          Fit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn('text-white/80 hover:bg-white/10 hover:text-white', atActual && 'text-white')}
          aria-pressed={atActual}
          title="Actual size, one image pixel per screen pixel (1)"
          onClick={() => zoomTo(1 / (fitScale || 1))}
        >
          1:1
        </Button>
        <a
          href={image.url}
          download={image.filename}
          className="inline-flex size-7 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
          aria-label="Save image"
          title="Save image"
        >
          <Download className="size-4" />
        </a>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-white/80 hover:bg-white/10 hover:text-white"
          aria-label="Close image"
          title="Close (Esc)"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div
        ref={setSurface}
        tabIndex={-1}
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden outline-none',
          view.scale > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
        )}
        onWheel={(event) => {
          // Cursor-anchored: the feature under the pointer stays under the pointer.
          const rect = event.currentTarget.getBoundingClientRect();
          const px = event.clientX - rect.left;
          const py = event.clientY - rect.top;
          zoomAt(px, py, view.scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2));
        }}
        onDoubleClick={() => (atFit ? zoomTo(2) : setView(FIT_VIEW))}
        onPointerDown={(event) => {
          movedRef.current = false;
          capturedRef.current = false;
          if (event.button !== 0) return;
          if (view.scale <= 1) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          // Set Pointer Capture retargets every later pointer event, including the click, to this
          // element. Without remembering that, a click at any zoom looks like "clicked the
          // backdrop" and closes the viewer - which is what made double-click-to-fit dismiss it.
          capturedRef.current = true;
          dragRef.current = { x: event.clientX, y: event.clientY, originX: view.x, originY: view.y };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
          setView((current) => ({ ...current, x: drag.originX + dx, y: drag.originY + dy }));
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onClick={(event) => {
          // A pan ends with a click; only a click that never moved counts as "outside the image".
          if (movedRef.current) {
            movedRef.current = false;
            return;
          }
          // A gesture that captured the pointer reports the surface as the click target even when
          // it started on the image, so it can never be read as "outside". Also skip the clicks that
          // make up a double-click, which is how zoom-to-fit is invoked.
          if (capturedRef.current) {
            capturedRef.current = false;
            return;
          }
          if (event.detail > 1) return;
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <img
          ref={imgRef}
          src={image.url}
          alt={image.filename}
          draggable={false}
          onLoad={(event) => {
            const el = event.currentTarget;
            setNatural({ w: el.naturalWidth, h: el.naturalHeight });
            setBox((current) => current ?? { w: surface?.clientWidth ?? 0, h: surface?.clientHeight ?? 0 });
          }}
          className="max-h-full max-w-full select-none object-contain transition-transform duration-75 ease-out"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
        {images.length > 1 ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/75 text-white shadow-lg ring-1 ring-white/30 backdrop-blur-sm hover:bg-black/90 hover:text-white focus-visible:ring-2 focus-visible:ring-white"
              aria-label="Previous image"
              title="Previous image (←)"
              onClick={() => onIndex(neighborIndex(images.length, index, -1))}
            >
              <ChevronLeft className="size-5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/75 text-white shadow-lg ring-1 ring-white/30 backdrop-blur-sm hover:bg-black/90 hover:text-white focus-visible:ring-2 focus-visible:ring-white"
              aria-label="Next image"
              title="Next image (→)"
              onClick={() => onIndex(neighborIndex(images.length, index, 1))}
            >
              <ChevronRight className="size-5" />
            </Button>
          </>
        ) : null}
      </div>

      {/* A quiet hint line, so "what am I looking at" never needs guessing. */}
      <div className="flex flex-none items-center justify-center gap-3 px-3 py-1.5 text-[11px] text-white/45">
        {natural ? (
          <span className="tabular-nums">
            {natural.w} × {natural.h} px
          </span>
        ) : null}
        <span>{atActual ? 'actual size' : atFit ? 'fitted to window' : `${actualPercent}% of actual size`}</span>
        <span className="hidden sm:inline">Double-click to toggle · Esc to close</span>
      </div>
    </Dialog.Content>
    </Dialog.Portal>
    </Dialog.Root>
  );
}
