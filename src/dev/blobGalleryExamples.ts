import { BUDDY_SHAPES } from '../blob/buddy';
import { CRYSTAL_SHAPES } from '../blob/crystal';
import { LAVA_SHAPES } from '../blob/lava';
import { MOSAIC_SHAPES } from '../blob/mosaic';
import { SCRIBBLE_SHAPES } from '../blob/scribble';
import { AVATAR_COLOR_COUNT } from '../blob/contrast';
import { hashString, seedIdentity } from '../blob/seed';
import type { AvatarIdentity, BlobStyle } from '../types';

const shapes = {
  buddy: BUDDY_SHAPES,
  crystal: CRYSTAL_SHAPES,
  lava: LAVA_SHAPES,
  mosaic: MOSAIC_SHAPES,
  scribble: SCRIBBLE_SHAPES,
};

/** Three different cuts and colours, held constant across states for direct comparison. */
export function galleryExamples(style: BlobStyle, seed: string, color?: string): AvatarIdentity[] {
  const choices = shapes[style];
  const start = hashString(`gallery:${style}:${seed}`);
  const stride = Math.floor(choices.length / 3);
  return Array.from({ length: 3 }, (_, index) => ({
    ...seedIdentity(index === 0 ? seed : `${seed}:example-${index + 1}`),
    shapeName: choices[(start + index * stride) % choices.length].name,
    colorIndex: (hashString(`gallery-color:${seed}`) + index * 7) % AVATAR_COLOR_COUNT,
    ...(color ? { color } : {}),
  }));
}
