import * as React from 'react';

type Pointer = { x: number; y: number };
type Subscriber = (pointer: Pointer | null, remeasure: boolean) => void;

// One set of window listeners and one animation frame shared by every blob.
const subscribers = new Set<Subscriber>();
let frame = 0;
let last: Pointer | null = null;
let dirty = false;

const flush = () => {
  frame = 0;
  const remeasure = dirty;
  dirty = false;
  subscribers.forEach(subscriber => subscriber(last, remeasure));
};

const schedule = (remeasure = false) => {
  dirty ||= remeasure;
  if (last && !frame) frame = window.requestAnimationFrame(flush);
};
const onMove = (event: MouseEvent) => {
  last = { x: event.clientX, y: event.clientY };
  schedule();
};
const onGeometryChange = () => schedule(true);
const release = () => {
  // A later resize/scroll must not resurrect the last gaze after blur or pointer exit.
  last = null;
  if (frame) window.cancelAnimationFrame(frame);
  frame = 0;
  dirty = false;
  subscribers.forEach(subscriber => subscriber(null, true));
};

const subscribe = (subscriber: Subscriber): (() => void) => {
  subscribers.add(subscriber);
  if (subscribers.size === 1) {
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('scroll', onGeometryChange, { capture: true, passive: true });
    window.addEventListener('resize', onGeometryChange);
    window.addEventListener('blur', release);
    document.documentElement.addEventListener('mouseleave', release);
  }
  schedule(true);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('scroll', onGeometryChange, { capture: true });
      window.removeEventListener('resize', onGeometryChange);
      window.removeEventListener('blur', release);
      document.documentElement.removeEventListener('mouseleave', release);
      release();
    }
  };
};

/** Cursor distance (px) within which the pupils react; farther away they settle back to centre. */
const NEAR_RADIUS = 260;
/** Catch layout shifts that don't emit a resize/scroll while the cursor moves. */
const RECT_TTL_MS = 500;

/**
 * Moves pupils toward the nearby cursor, in viewBox units, optionally constrained by eye geometry.
 * The tracking attribute lets autonomous gaze yield. Cached layout boxes are refreshed together
 * on scroll/resize (even with a stationary cursor), or when a wrapper changes size.
 */
export const usePupilTracking = (
  wrapperRef: React.RefObject<HTMLElement | null>,
  pupilRefs: Array<React.RefObject<SVGElement | null>>,
  enabled: boolean,
  reach = 5,
  mapOffset?: (x: number, y: number) => [number, number]
): void => {
  const pupils = React.useRef(pupilRefs);
  pupils.current = pupilRefs;

  React.useEffect(() => {
    if (!enabled) return;
    const wrapper = wrapperRef.current;
    let cached: { rect: DOMRect; at: number } | null = null;
    const reset = () => {
      wrapper?.removeAttribute('data-pupil-tracking');
      pupils.current.forEach(ref => ref.current?.removeAttribute('transform'));
    };
    const unsubscribe = subscribe((pointer, remeasure) => {
      if (remeasure) cached = null;
      if (!pointer) {
        reset();
        return;
      }
      if (!cached || performance.now() - cached.at > RECT_TTL_MS) {
        const rect = wrapper?.getBoundingClientRect();
        if (!rect) return;
        cached = { rect, at: performance.now() };
      }
      const dx = pointer.x - (cached.rect.left + cached.rect.width / 2);
      const dy = pointer.y - (cached.rect.top + cached.rect.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      const near = distance < NEAR_RADIUS ? 1 - distance / NEAR_RADIUS : 0;
      if (!near) {
        reset();
        return;
      }
      const pull = near * near * (3 - 2 * near);
      const x = (dx / distance) * reach * pull;
      const y = (dy / distance) * reach * pull;
      const [offsetX, offsetY] = mapOffset?.(x, y) ?? [x, y];
      wrapper?.setAttribute('data-pupil-tracking', 'true');
      const transform = `translate(${offsetX.toFixed(2)} ${offsetY.toFixed(2)})`;
      pupils.current.forEach(ref => ref.current?.setAttribute('transform', transform));
    });
    const observer = new ResizeObserver(onGeometryChange);
    if (wrapper) observer.observe(wrapper);
    return () => {
      observer.disconnect();
      unsubscribe();
      reset();
    };
  }, [enabled, reach, wrapperRef, mapOffset]);
};
