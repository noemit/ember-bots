/** Ceiling for the pre-measurement wide-rail fallback (`aside` caps at 760px on wide screens). */
export const WIDE_RAIL_MAX_STRIP_WIDTH = 660;
/**
 * Horizontal chrome inside `LeftRail`'s scroll container (`scroller.clientWidth`):
 * `px-1.5` rail scroll padding (12px) + `ProjectCard` border and `px-2` padding (18px) +
 * `SessionBlobStrip` `px-1` padding (8px) = 38px, plus 6px breathing room so `+N` never clips.
 */
export const WIDE_RAIL_CARD_PADDING = 44;
/** Fallback inset from `50vw` before `ResizeObserver` reports the scroll container's inner width. */
export const WIDE_RAIL_VIEWPORT_INSET = 48;
export const RAIL_STRIP_GAP = 4;
/** A blob's title chip is at least this wide, so a shrunken blob still gets a readable label. */
export const RAIL_STRIP_LABEL_WIDTH = 56;
/**
 * Two 13px label lines plus their 1px padding each, so 30: past this the chip clips rather than
 * grows. It was 35, which contradict this very comment and let a sliver of a third line show
 * through - a half-visible line reads as a broken chip. The e2e suite pins the ceiling.
 */
export const RAIL_STRIP_LABEL_HEIGHT = 30;

/**
 * Width a `ProjectCard` strip may actually use when `LeftRail` is in `wide` mode.
 *
 * Uses the scroll container's measured inner width once `ResizeObserver` has reported it
 * (subtracting `ProjectCard` + strip horizontal padding), and falls back before first measurement
 * to `Math.min(660, Math.floor(viewportWidth * 0.5) - 48)` so viewports from `768px` to `1391px`
 * never assume a 660px strip and clip blobs or the `+N` overflow chip.
 */
export const wideRailStripWidth = (
  measuredScrollerWidth: number | null | undefined,
  viewportWidth?: number
): number => {
  if (
    typeof measuredScrollerWidth === 'number' &&
    Number.isFinite(measuredScrollerWidth) &&
    measuredScrollerWidth > 0
  ) {
    return Math.max(RAIL_STRIP_LABEL_WIDTH, Math.floor(measuredScrollerWidth) - WIDE_RAIL_CARD_PADDING);
  }
  if (typeof viewportWidth === 'number' && Number.isFinite(viewportWidth) && viewportWidth > 0) {
    return Math.max(
      RAIL_STRIP_LABEL_WIDTH,
      Math.min(WIDE_RAIL_MAX_STRIP_WIDTH, Math.floor(viewportWidth * 0.5) - WIDE_RAIL_VIEWPORT_INSET)
    );
  }
  return WIDE_RAIL_MAX_STRIP_WIDTH;
};
