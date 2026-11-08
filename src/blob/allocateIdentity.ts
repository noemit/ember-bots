import type { AvatarAssignment, AvatarIdentity, AvatarOverride, BlobStyle, Session } from '../types';
import { AVATAR_COLOR_COUNT, IDENTITY_COLORS, perceptualDistance } from './contrast';
import { hashString, mulberry32 } from './seed';
import { BUDDY_SHAPES } from './buddy';
import { CRYSTAL_SHAPES } from './crystal';
import { LAVA_SHAPES } from './lava';
import { MOSAIC_SHAPES } from './mosaic';
import { effectiveBlobStyle, type ActiveBlobStyle } from './styles';

/** Active means unarchived top-level bots, including idle bots, not hidden worker threads. */
export const competesForIdentity = (session: Session): boolean =>
  !session.archived && session.kind !== 'worker' && !session.parentId && (!session.lead || session.kind === 'peer');

const shapesFor = (style: ActiveBlobStyle): readonly { name: string }[] => ({
  buddy: BUDDY_SHAPES, crystal: CRYSTAL_SHAPES, lava: LAVA_SHAPES, mosaic: MOSAIC_SHAPES,
})[style];

/** Same archetype draws as the renderers, without generating their paths or textures. */
export const identityShape = (requestedStyle: BlobStyle, identity: Pick<AvatarIdentity, 'shapeSeed' | 'shapeName' | 'style'>): string => {
  const style = effectiveBlobStyle(requestedStyle, identity);
  const shapes = shapesFor(style);
  if (shapes.some(shape => shape.name === identity.shapeName)) return identity.shapeName!;
  const seed = hashString(`${style}:${identity.shapeSeed}`);
  const rng = mulberry32(seed);
  if (style === 'buddy') rng();
  return shapes[Math.floor(rng() * shapes.length)].name;
};

/**
 * Allocate only at a known creation/promotion boundary, never during a poll or restoration.
 * Colours use the rendered palette's OKLab distance, not adjacent swatches or an id hash.
 * First avoid exact reuse; then maximize nearest-neighbour distance. When every swatch is
 * occupied, balance counts and prefer the least crowded perceptual neighbourhood.
 * Hashes break exact ties only, making identical inputs deterministic regardless of list order.
 */
export const allocateAvatar = (
  key: string,
  active: AvatarIdentity[],
  requestedStyle: BlobStyle,
  palette: readonly string[] = IDENTITY_COLORS,
  override: AvatarOverride = {},
): AvatarAssignment => {
  const style = effectiveBlobStyle(requestedStyle, override);
  // Poll ordering must not affect floating-point accumulation or deterministic tie breaks.
  const peers = [...active].sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
  const colors = peers.map(identity => identity.color ?? palette[identity.colorIndex ?? hashString(`avatar-color:${identity.sessionKey}`) % AVATAR_COLOR_COUNT]);
  const rank = palette.map((color, colorIndex) => {
    const distances = colors.map(other => perceptualDistance(color, other));
    return {
      colorIndex,
      uses: distances.filter(distance => distance < 0.000001).length,
      nearest: distances.length ? Math.min(...distances) : 1,
      crowding: distances.reduce((sum, distance) => sum + Math.exp(-((distance / .12) ** 2)), 0),
      tie: hashString(`${key}:color:${colorIndex}`),
    };
  }).sort((a, b) => a.uses - b.uses || b.nearest - a.nearest || a.crowding - b.crowding || a.tie - b.tie);
  const colorIndex = rank[0].colorIndex;
  // A chosen project/session colour wins; vary shape against that colour, not an unused fallback.
  const chosenColor = override.color ?? palette[override.colorIndex ?? colorIndex];
  const shapes = shapesFor(style);
  // Shape names are local to each style; a 'cloud' in another style is not this silhouette.
  const peerShapes = peers.map(identity => effectiveBlobStyle(requestedStyle, identity) === style
    ? identityShape(requestedStyle, identity) : undefined);
  const nearby = colors.map(color => perceptualDistance(chosenColor, color) < .15);
  // Once shapes are exhausted, avoid a same-colour/same-shape pair before balancing reuse.
  const rankedShapes = shapes.map(shape => ({
    name: shape.name,
    uses: peerShapes.filter(name => name === shape.name).length,
    nearby: peerShapes.filter((name, index) => name === shape.name && nearby[index]).length,
    tie: hashString(`${key}:shape:${shape.name}`),
  })).sort((a, b) => a.nearby - b.nearby || a.uses - b.uses || a.tie - b.tie);
  // Persist a seed, not a user override: changing styles still yields that style's own geometry.
  // Every renderer consumes its seed differently, so search for the selected archetype once.
  for (let attempt = 0; attempt < 4096; attempt++) {
    const shapeSeed = `allocated:${key}:${attempt}`;
    if (identityShape(style, { shapeSeed }) === rankedShapes[0].name) return { colorIndex, shapeSeed };
  }
  return { colorIndex, shapeSeed: `allocated:${key}` };
};
