/**
 * The faces that ship, and which body each is drawn on.
 *
 * This is the single source of truth for a Mosaic face. The designer page reads it, and so does the
 * avatar in the rail — the earlier split (a page with its own list, an allocator with its own shapes)
 * is exactly how eighteen faces came to exist while only one rendered.
 *
 * ## A face is a composition, not a shape plus a decoration
 *
 * `body` is part of the drawing. A hat needs the wide crown of `pebble` or `ribbon`; something
 * hanging at the sides needs `pebble`'s width. So the body here **overrides** whatever silhouette the
 * avatar allocator picked — that is not a collision with allocation, it is the point: the allocator's
 * job becomes choosing a *face*, not choosing a silhouette.
 *
 * ## Colour is not part of a face
 *
 * Every face is drawn in one accessible colourway in `mosaicAccessories`, but the session's own
 * colour still wins at render time. Two sessions with the same face read as different people because
 * their bodies are different colours, which is why eleven duplicate silhouettes are fine.
 */

import type { MosaicAccessory } from './mosaicAccessories';

/** One face: a body, and the accessory drawn on it. */
export type FaceSpec = {
  /** Stable id, matching the designer's keep ids (`accessory.variant`) and `'plain'`. */
  id: string;
  /** What it is, in a person's words. */
  label: string;
  /** `null` only for the plain face. */
  accessory: MosaicAccessory | null;
  /** Which variant of that accessory. Meaningless when `accessory` is null. */
  variant: number;
  /** The silhouette this face is built on, from `MOSAIC_SHAPES`. */
  body: string;
  /** Rows to push the *body* down, when a garment already occupies the topmost drawable row. */
  bodyShift?: number;
};

/**
 * The eighteen.
 *
 * Ordered plain-first, then by where the thing sits on the body, so the list reads as a wardrobe and
 * a new entry has an obvious home. The ids are the designer's, so a drawing saved there names the
 * same face here.
 */
export const FACES: readonly FaceSpec[] = [
  { id: 'plain', label: 'Plain', accessory: null, variant: 0, body: 'sprig' },

  // Eyewear. The bandanas leave the eye cells bare so the eyes sit on the cloth rather than behind it.
  { id: 'tears.3', label: 'Tears', accessory: 'tears', variant: 2, body: 'pebble' },
  { id: 'eyelashes.1', label: 'Eyelashes', accessory: 'eyelashes', variant: 0, body: 'crown' },
  { id: 'bandana.1', label: 'Bandana, brown', accessory: 'bandana', variant: 0, body: 'pebble' },
  { id: 'bandana.2', label: 'Bandana, red', accessory: 'bandana', variant: 1, body: 'crown' },
  { id: 'scientist.1', label: 'Scientist', accessory: 'scientist', variant: 0, body: 'tuft' },

  // Worn on the head.
  { id: 'crown.1', label: 'Crown', accessory: 'crown', variant: 0, body: 'tuft' },
  { id: 'halo.1', label: 'Halo', accessory: 'halo', variant: 0, body: 'sail' },
  // The horns already occupy row 0 — the topmost row the SVG can draw — so the *body* drops a row
  // instead, which is the only way to sit them higher against the head.
  { id: 'horns.1', label: 'Horns', accessory: 'horns', variant: 0, body: 'pebble', bodyShift: 1 },
  { id: 'roundHat.1', label: 'Round hat, brown', accessory: 'roundHat', variant: 0, body: 'ribbon' },
  { id: 'roundHat.2', label: 'Round hat, white', accessory: 'roundHat', variant: 1, body: 'sail' },
  { id: 'skaterHat.1', label: 'Skater hat', accessory: 'skaterHat', variant: 0, body: 'crown' },
  { id: 'headphones.1', label: 'Headphones', accessory: 'headphones', variant: 0, body: 'sprig' },

  // Marks on the face itself.
  { id: 'starSticker.1', label: 'Star sticker', accessory: 'starSticker', variant: 0, body: 'ribbon' },
  { id: 'blushing.1', label: 'Blushing', accessory: 'blushing', variant: 0, body: 'sail' },
  { id: 'flower.1', label: 'Flower, red', accessory: 'flower', variant: 0, body: 'sprig' },
  { id: 'flower.2', label: 'Flower, violet', accessory: 'flower', variant: 1, body: 'tuft' },
  { id: 'flower.3', label: 'Flower, yellow', accessory: 'flower', variant: 2, body: 'ribbon' },
];

/** Fast lookup by id, for the designer and for a pinned `faceId`. */
export const FACE_BY_ID: ReadonlyMap<string, FaceSpec> = new Map(FACES.map((face) => [face.id, face]));
