/**
 * The body-assignment record shared by the face set and the drawing tool's save path.
 *
 * Why this is its own module rather than a constant in `faceSetMain.tsx`: the assignment is no
 * longer code. A person changes it in the page, it is persisted, and `serve.sh` writes it into the
 * same `drawings.json` as the drawings — so the file on disk is the export, and re-reading it must
 * produce the page that wrote it. Keeping the default map, the storage key and the parse rules in one
 * place is what lets the page and the save agree about what "the assignments" means.
 */
import { MOSAIC_SHAPES } from '../blob/mosaic';

/**
 * Which body each face is built on, before anyone changes it.
 *
 * A face is a *composition*: the body is part of the drawing, not a viewer setting. A hat needs the
 * wide crown of `pebble` or `ribbon`; something hanging at the sides needs `pebble`'s width; a mark
 * low on the face reads best against `tuft`'s taper. Swapping bodies under a finished garment is how
 * the earlier gallery showed hats floating off narrow heads.
 *
 * This map is the **default**, not the answer. The page's picker writes overrides to `localStorage`,
 * because changing a silhouette should not mean editing a file and reloading, and the distribution
 * row below the header counts whatever is currently chosen.
 */
export const FACE_BODY: Readonly<Record<string, string>> = {
  plain: 'sprig',
  'tears.3': 'pebble',
  'eyelashes.1': 'crown',
  'bandana.1': 'pebble',
  'bandana.2': 'crown',
  'scientist.1': 'tuft',
  'crown.1': 'tuft',
  'halo.1': 'sail',
  'horns.1': 'pebble',
  'roundHat.1': 'ribbon',
  'roundHat.2': 'sail',
  'skaterHat.1': 'crown',
  'headphones.1': 'sprig',
  'starSticker.1': 'ribbon',
  'blushing.1': 'sail',
  'flower.1': 'sprig',
  'flower.2': 'tuft',
  'flower.3': 'ribbon',
};

/**
 * Faces whose body is drawn one row lower, so the accessory reads higher against it.
 *
 * The horns already occupy row 0 — the topmost row the SVG can draw, since the grid starts at
 * `translate(8 1)` and row −1 would land at y=−6, above the viewBox. Moving the *drawing* up is
 * therefore impossible without moving every face; moving the *head* down achieves the same look and
 * touches one face instead of all of them.
 *
 * The offset is a row of body, not of accessory: the garment stays where it was drawn, and the head
 * it sits on drops. That is what makes it read as "horns higher" rather than "horns floating".
 */
export const FACE_BODY_SHIFT: Readonly<Record<string, number>> = {
  'horns.1': 1,
};

/** Where the page keeps its overrides. Named for the thing, so a stray key in storage is obvious. */
export const FACE_BODY_KEY = 'mosaic-face-bodies';

/** The six silhouette names, in the canonical order the page lists them. */
export const BODY_NAMES: readonly string[] = MOSAIC_SHAPES.map((shape) => shape.name);

const isBody = (value: unknown): value is string =>
  typeof value === 'string' && BODY_NAMES.includes(value);

/**
 * Read the overrides out of whatever `localStorage` held.
 *
 * Anything unrecognised is dropped rather than thrown: a silhouette that no longer exists (a body
 * renamed, a hand-edited key) would otherwise land on a face the renderer does not have, and
 * `mosaicGeometry` answers an unknown `shapeName` by picking a silhouette *at random* — so the same
 * saved assignment would draw a different body on every reload. That is the one failure mode worth
 * ruling out, because it looks like the assignment was never saved.
 */
export const readBodyOverrides = (raw: string | null): Record<string, string> => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const overrides: Record<string, string> = {};
    for (const [id, body] of Object.entries(parsed as Record<string, unknown>)) {
      if (isBody(body)) overrides[id] = body;
    }
    return overrides;
  } catch {
    return {};
  }
};

/** The current assignment: the defaults, with any valid override on top. */
export const resolveBodies = (overrides: Readonly<Record<string, string>>): Record<string, string> => {
  const resolved: Record<string, string> = { ...FACE_BODY };
  for (const [id, body] of Object.entries(overrides)) {
    if (isBody(body) && id in FACE_BODY) resolved[id] = body;
  }
  return resolved;
};
