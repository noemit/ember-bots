/** Stable per-chat compositions. Explicit saved silhouettes always take precedence. */
import { FACE_BY_ID, FACES, type FaceSpec } from './mosaicFaces';
import { MOSAIC_ACCESSORIES } from './mosaicAccessories';
import { hashString } from './seed';
import type { AvatarIdentity } from '../types';

export type FacePixel = { x: number; y: number; fill: string };

/** No visible-set allocation: opening or hiding another chat cannot change this face. */
export const faceFor = (identity: AvatarIdentity): FaceSpec => {
  const shapeName = identity.shapeName === 'automatic' ? undefined : identity.shapeName;
  const compatible = (face: FaceSpec) => !shapeName || face.body === shapeName;
  const pinned = identity.faceId ? FACE_BY_ID.get(identity.faceId) : undefined;
  if (pinned && compatible(pinned)) return pinned;
  const candidates = FACES.filter(compatible);
  // Unknown/legacy explicit shapes keep their original body without an ill-fitting accessory.
  if (!candidates.length) return { ...FACES[0], body: shapeName! };
  return candidates[hashString('face:' + identity.motionSeed) % candidates.length];
};

export const facePixels = (face: FaceSpec): readonly FacePixel[] => {
  if (!face.accessory) return [];
  const variant = MOSAIC_ACCESSORIES[face.accessory].variants[face.variant];
  return variant?.pixels.map(([x, y, fill]) => ({ x, y, fill })) ?? [];
};

export const faceCoversEyes = (face: FaceSpec): boolean =>
  face.accessory ? MOSAIC_ACCESSORIES[face.accessory].variants[face.variant]?.coversEyes ?? false : false;

/** Only an automatic body may be replaced by the compatible composition's body. */
export const identityForFace = (identity: AvatarIdentity, face: FaceSpec): AvatarIdentity => ({
  ...identity,
  shapeName: identity.shapeName && identity.shapeName !== 'automatic' ? identity.shapeName : face.body,
});
