/**
 * The drawing record: what a saved drawing is, and how one travels out of the browser.
 *
 * The editor's canvas state is deliberately plain — an array of `{ x, y, fill, anim? }` — because it
 * is redrawn from it on every cell. A saved drawing needs a little more: a **name** to find it by, the
 * **face** it belongs to so a save can be matched to a ship-list entry, and the `coversEyes` flag,
 * which is part of the drawing rather than a note about it. This module is where that shape lives so
 * the editor, the page that hosts it and `serve.sh`'s client all agree on it.
 *
 * Nothing here talks to the network: the editor owns the buttons, and keeping the shape separate is
 * what lets the save/load paths be read without the JSX in between.
 */
import type { MosaicAnim } from '../blob/mosaicAccessories';

/** One cell of a drawing. Same shape the renderer consumes, so no conversion step can drift. */
export type DrawingPixel = { x: number; y: number; fill: string; anim?: MosaicAnim };

/** A saved drawing, as `drawings.json` stores it. */
export type SavedDrawing = {
  /** What a person calls it. Also the key under `drawings`, so two saves with one name replace. */
  name: string;
  /** The ship-list face this drawing is for, when it is known. `null` for a free sketch. */
  face: string | null;
  /** True when the art paints over the eye row; the renderer skips the eyes entirely. */
  coversEyes: boolean;
  /** ISO timestamp of the last save. Only ever shown, never compared. */
  savedAt: string;
  pixels: DrawingPixel[];
};

/** The file `serve.sh` keeps. Sorted keys on disk; this is the in-memory shape. */
export type DrawingsFile = {
  _note?: string;
  drawings: Record<string, SavedDrawing>;
  bodies?: Record<string, string>;
  bodiesAt?: string | null;
};

/** Where the editor keeps its working drawing between reloads. */
export const DRAWING_KEY = 'mosaic-drawing';
/** Where the page keeps the name last saved under, so Save does not ask every time. */
export const DRAWING_NAME_KEY = 'mosaic-drawing-name';
/** Where the editor remembers which face the drawing is for. */
export const DRAWING_FACE_KEY = 'mosaic-drawing-face';

/**
 * Coerce anything parsed out of storage or off disk into pixels the canvas can draw.
 *
 * A drawing is hand-edited or JSON-pasted often enough that trusting its shape is a crash waiting on
 * a refresh. Bad cells are dropped rather than repaired: a wrong colour cannot be guessed, and one
 * silently invented pixel is worse than a missing one, because the missing one is visible.
 */
export const parsePixels = (value: unknown): DrawingPixel[] => {
  if (!Array.isArray(value)) return [];
  const pixels: DrawingPixel[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { x, y, fill, anim } = entry as Record<string, unknown>;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof fill !== 'string') continue;
    const pixel: DrawingPixel = { x, y, fill };
    // The animation set is closed (see `MosaicAnim`); an unknown name would put a class on a rect
    // that matches no keyframes and silently freeze the cell.
    if (anim === 'screen' || anim === 'screenIdle') pixel.anim = anim;
    pixels.push(pixel);
  }
  return pixels;
};

/** One saved drawing, from whatever the file held. `null` when there is not enough there to draw. */
export const parseDrawing = (name: string, value: unknown): SavedDrawing | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const pixels = parsePixels(record.pixels);
  if (pixels.length === 0) return null;
  return {
    name,
    face: typeof record.face === 'string' ? record.face : null,
    coversEyes: record.coversEyes === true,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
    pixels,
  };
};

/** The sort the renderer and the export both use: top-to-bottom, then left-to-right. */
export const sortPixels = (pixels: readonly DrawingPixel[]): DrawingPixel[] =>
  [...pixels].sort((a, b) => a.y - b.y || a.x - b.x);

/**
 * The `pixels: [...]` block that goes into `mosaicAccessories.ts`.
 *
 * A saved drawing on disk is still a *proposal* until it is pasted into the record, and the editor's
 * shape and the record's shape are the same literals — so the export is one function, used by the
 * copy button and by whoever opens the JSON.
 */
export const codeBlock = (drawing: Pick<SavedDrawing, 'name' | 'coversEyes' | 'pixels'>): string => {
  const rows = sortPixels(drawing.pixels)
    .map((pixel) => `          [${pixel.x}, ${pixel.y}, '${pixel.fill}'${pixel.anim ? `, '${pixel.anim}'` : ''}],`)
    .join('\n');
  return `note: '${drawing.name}',\n        coversEyes: ${drawing.coversEyes},\n        pixels: [\n${rows}\n        ],`;
};

/**
 * A default name for an unsaved drawing.
 *
 * Date-stamped rather than numbered: two drawings started on the same day still get distinct names,
 * and a name that says *when* is the one fact that survives being looked at a week later.
 */
export const defaultDrawingName = (face: string | null, now: Date = new Date()): string => {
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return face ? `${face} ${stamp}` : `drawing ${stamp}`;
};
