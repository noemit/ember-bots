import type { AvatarIdentity, AvatarOverride, BlobStyle, DraftAppearance, Session } from '../types';
import { sessionAvatarKey } from '../blob/seed';
import { effectiveBlobStyle, type ActiveBlobStyle } from '../blob/styles';
import { BUDDY_SHAPES } from '../blob/buddy';
import { CRYSTAL_SHAPES } from '../blob/crystal';
import { LAVA_SHAPES } from '../blob/lava';
import { MOSAIC_SHAPES } from '../blob/mosaic';

const shapeExists = (style: ActiveBlobStyle, name: string): boolean => ({
  buddy: BUDDY_SHAPES, crystal: CRYSTAL_SHAPES, lava: LAVA_SHAPES, mosaic: MOSAIC_SHAPES,
})[style].some(shape => shape.name === name);

/** Save the preview itself: incoming bots must not change a choice made in the draft picker. */
export const freezeDraftAppearance = (preview: AvatarIdentity, fallbackStyle: BlobStyle): DraftAppearance => {
  const style = effectiveBlobStyle(fallbackStyle);
  return {
    assignment: { colorIndex: preview.colorIndex ?? 0, shapeSeed: preview.shapeSeed },
    override: {
      // A new bot inherits the global style. A named shape is retained only when it exists
      // in that style; seeded geometry remains deterministic when it does not.
      ...(preview.shapeName && shapeExists(style, preview.shapeName) ? { shapeName: preview.shapeName } : { shapeName: 'automatic' }),
      // A second client may already have saved an automatic assignment for the new session.
      // Explicit choices still win, including Buddy's pupil palette and seeded geometry.
      shapeSeed: preview.shapeSeed,
      colorIndex: preview.colorIndex ?? 0,
      // Keep seeded geometry seeded: converting its archetype to a named shape changes the RNG
      // draw order in Crystal/Lava. The automatic sentinel masks a folder shape after a style
      // switch without persisting a per-bot style override.
      ...(preview.color ? { color: preview.color } : {}),
    },
  };
};

/** A draft choice is always session-scoped, never an implicit edit to the folder's appearance. */
export const withSessionAppearance = (
  session: Session,
  overrides: Record<string, AvatarOverride>,
  appearance?: AvatarOverride,
): Record<string, AvatarOverride> => appearance
  ? { ...overrides, [sessionAvatarKey(session)]: appearance }
  : overrides;

/** Colour swatches override an inherited custom colour without erasing unrelated preview fields. */
export const previewDraftAppearance = (base: AvatarIdentity, override: AvatarOverride): AvatarIdentity => ({
  ...base,
  ...override,
  // The custom-colour input clears its palette override with undefined; that must not erase
  // the underlying assignment (Buddy also uses its index for the pupil colour).
  colorIndex: override.colorIndex ?? base.colorIndex,
  color: override.color ?? (override.colorIndex !== undefined ? undefined : base.color),
  style: base.style,
});
