import { IDENTITY_COLORS } from './contrast';
import { BUDDY_COLORS } from './buddy';
import { hashString, mulberry32, seedIdentity } from './seed';
import type { AvatarIdentity, BlobStyle } from '../types';

/**
 * The dominant colour of the blob a seed renders in the given style, as a CSS colour, so UI
 * around a session (e.g. the activity dot) can pick up its identity. Each branch consumes the
 * RNG in the same order as the matching renderer, so this stays in lockstep with what's drawn.
 */
export const blobColor = (style: BlobStyle, seedOrIdentity: string | AvatarIdentity): string => {
  const identity = typeof seedOrIdentity === 'string' ? seedIdentity(seedOrIdentity) : seedOrIdentity;
  if (identity.color) return identity.color;
  switch (style) {
    case 'mosaic': {
      const index = identity.colorIndex ?? hashString(`mosaic:${identity.colorSeed}`) % IDENTITY_COLORS.length;
      return `var(--blob-${Math.abs(index) % IDENTITY_COLORS.length})`;
    }
    case 'lava': {
      // LavaBlob draws its colour first from this stream; keep the two in step.
      const rng = mulberry32(hashString(`lava:${identity.colorSeed}`));
      const index = identity.colorIndex ?? Math.floor(rng() * IDENTITY_COLORS.length);
      return `var(--blob-${Math.abs(index) % IDENTITY_COLORS.length})`;
    }
    case 'crystal': {
      const rng = mulberry32(hashString(`crystal:${identity.colorSeed}`));
      rng();
      const index = identity.colorIndex ?? Math.floor(rng() * IDENTITY_COLORS.length);
      return `var(--blob-${Math.abs(index) % IDENTITY_COLORS.length})`;
    }
    default: {
      const rng = mulberry32(hashString(`buddy:${identity.colorSeed}`));
      const groupedColor = Boolean(identity.projectKey || identity.colorIndex !== undefined);
      const index = identity.colorIndex ?? Math.floor(
        rng() * (groupedColor ? IDENTITY_COLORS.length : BUDDY_COLORS.length)
      );
      return groupedColor
        ? `var(--blob-${Math.abs(index) % IDENTITY_COLORS.length})`
        : BUDDY_COLORS[Math.abs(index) % BUDDY_COLORS.length].fill;
    }
  }
};
