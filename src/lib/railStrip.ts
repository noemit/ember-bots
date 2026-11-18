/**
 * A rail card's strip, as numbers. The strip itself is `components/SessionBlobStrip`; the group
 * card needs the same counts in two places — the blobs it draws, and the names its tidy-up menu
 * lists for the sessions the strip couldn't fit — so the arithmetic lives here once, purely,
 * instead of being repeated in the card and above the strip.
 */
import { blobStripLayout, type BlobStrip } from './projectGroups';
import type { Session } from '../types';
import { sessionKey } from '../types';

/** The rail is 320px wide; a strip sits inside its px-1.5 plus the card's px-2 padding. */
export const RAIL_STRIP_WIDTH = 280;
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
/** Blob sizes every rail card shares. */
export const RAIL_STRIP_MAX_SIZE = 48;
export const RAIL_STRIP_MIN_SIZE = 30;
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

/** `blobStripLayout` at the rail's own measurements. */
export const railStripLayout = (count: number): BlobStrip =>
  blobStripLayout(
    count,
    RAIL_STRIP_WIDTH,
    RAIL_STRIP_MAX_SIZE,
    RAIL_STRIP_MIN_SIZE,
    RAIL_STRIP_GAP,
    RAIL_STRIP_LABEL_WIDTH
  );

export type StripSplit<T> = { shown: T[]; hidden: T[] };

/**
 * The two halves of a strip: the sessions drawn as blobs, and the ones standing behind `+N`. A
 * group card's menu names the hidden ones, so this is the single answer to "which are those?".
 */
export const splitStrip = <T,>(members: readonly T[], layout: Pick<BlobStrip, 'visible'>): StripSplit<T> => ({
  shown: members.slice(0, layout.visible),
  hidden: members.slice(layout.visible),
});

/**
 * Where a group card's `+` starts its new agent: on the group's primary member's instance, in that
 * member's folder — the same seeding the group panel uses. Falls back to the first member when the
 * primary no longer resolves, and to `undefined` when the group has no members, so the card can
 * leave the button off rather than guess an instance.
 */
export const groupNewAgentTarget = (
  members: readonly Session[],
  primaryKey: string | undefined
): { instanceId: string; directory: string | undefined } | undefined => {
  const primary =
    primaryKey === undefined ? undefined : members.find((member) => sessionKey(member) === primaryKey);
  const member = primary ?? members[0];
  if (!member) return undefined;
  return { instanceId: member.instanceId, directory: member.directory };
};
