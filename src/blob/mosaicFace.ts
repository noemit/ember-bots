/**
 * Choosing which face an avatar wears, and the pixels that face draws.
 *
 * The rule the owner set: **the eighteen faces are the unit.** Two sessions may share a silhouette,
 * and may share a face even, because colour carries the difference — what must not happen is the rail
 * filling with the same face over and over while seventeen others go unused.
 *
 * So the choice is seeded per session (stable across reloads) and then walked past any face the rail
 * already holds. That mirrors how the buddy and crystal styles avoid repeating a noun: a hash decides
 * where to start, and collisions step forward rather than redrawing at random, which would still
 * cluster.
 */

import { FACE_BY_ID, FACES, type FaceSpec } from './mosaicFaces';
import { MOSAIC_ACCESSORIES, type MosaicAnim, type MosaicAccessory } from './mosaicAccessories';
import { hashString } from './seed';
import type { AvatarIdentity } from '../types';

/** A pixel of a face, ready to draw. */
export type FacePixel = { x: number; y: number; fill: string; anim?: MosaicAnim };

/**
 * Which face this avatar wears.
 *
 * `identity.faceId` wins when present: the designer pins a face while it is being judged, and tests
 * pin one to make an assertion about a specific drawing. Otherwise the identity's own seed picks, so a
 * session keeps its face across reloads and restarts without it being stored anywhere.
 *
 * `taken` is the ids of faces already on screen. The walk stops at the first free one rather than
 * always taking the hash's first answer, and wraps, so the eighteenth session in a crowded rail still
 * finds an unused face when one exists.
 */
export const faceFor = (identity: AvatarIdentity, taken: readonly string[] = []): FaceSpec => {
  if (identity.faceId) {
    const pinned = FACE_BY_ID.get(identity.faceId);
    if (pinned) return pinned;
    // A pinned face that no longer exists falls through to the hash rather than throwing: the ship
    // list can lose an entry, and a blob that refuses to draw is worse than one wearing a different
    // face.
  }
  const used = new Set(taken);
  const start = hashString(`face:${identity.shapeSeed}`) % FACES.length;
  for (let step = 0; step < FACES.length; step += 1) {
    const candidate = FACES[(start + step) % FACES.length];
    if (!used.has(candidate.id)) return candidate;
  }
  // Every face is in use: repeat, rather than render nothing.
  return FACES[start];
};

/** The face's own pixels, or none for the plain face. */
export const facePixels = (face: FaceSpec): readonly FacePixel[] => {
  if (!face.accessory) return [];
  const art = MOSAIC_ACCESSORIES[face.accessory as MosaicAccessory];
  const variant = art.variants[face.variant];
  if (!variant) return [];
  return variant.pixels.map(([x, y, fill, anim]) => ({ x, y, fill, anim }));
};

/** Whether the face hides the eyes (a mask, rather than a pair of glasses). */
export const faceCoversEyes = (face: FaceSpec): boolean => {
  if (!face.accessory) return false;
  return MOSAIC_ACCESSORIES[face.accessory as MosaicAccessory].variants[face.variant]?.coversEyes ?? false;
};

/**
 * The identity to draw this face with.
 *
 * The body is part of the drawing, so the face's `body` replaces whatever the allocator chose. Colour
 * is *not*: the session keeps its own, which is what lets two sessions wear the same face and still
 * read as two people.
 */
export const identityForFace = (identity: AvatarIdentity, face: FaceSpec): AvatarIdentity => ({
  ...identity,
  shapeName: face.body,
});
