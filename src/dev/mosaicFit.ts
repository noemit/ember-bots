/**
 * Where a drawing sits on a body: one geometry pass, shared by the editor and the face set.
 *
 * The editor asks ("which cells exist on *every* body? which on some? which are eyes?"), and the face
 * set asks something narrower ("do this face's pixels land on cells the body it was assigned has?").
 * Those are the same question about the same `mosaicGeometry` output, so answering them in two places
 * would be two chances to disagree — and the second one would only be discovered by looking at a face
 * and wondering why the warning did not fire.
 *
 * The cells are the ones the renderer draws, which is not the same thing as `MOSAIC_SHAPES[].rows`:
 * `mosaicGeometry` mirrors some bodies, moving every x. So this asks it directly, with the seed it
 * shares with the face set, and what it returns is the body as drawn rather than the body as declared.
 */
import * as React from 'react';
import { mosaicGeometry, MOSAIC_SHAPES } from '../blob/mosaic';
import { seedIdentity } from '../blob/seed';

/** Every set below is keyed `x,y`, the shape both callers index by. */
export const cellKey = (x: number, y: number): string => `${x},${y}`;

export type GridFacts = {
  /** Cells every one of the six bodies has: safe to draw on any silhouette. */
  universal: Set<string>;
  /** Cells at least one body has: the rest float clear of the shape entirely. */
  anywhere: Set<string>;
  /** Eye cells across all bodies, including both width-2 eyes. */
  eyeCells: Set<string>;
  /** Per-body cell sets, for the fit check. */
  perBody: Map<string, Set<string>>;
  /** The reference silhouette behind the grid. */
  bodyCells: Set<string>;
};

/**
 * Compute the grid facts once.
 *
 * A hook rather than a constant because `mosaicGeometry` is not free — it hashes a seed and walks
 * twelve rows per body — and this runs in a page that re-renders on every painted cell. `React.useMemo`
 * with no dependencies is the "compute once per mount, share across callers" idiom the editor already
 * used; the face set mounts it once at the top for the same reason.
 */
export function useGridFacts(): GridFacts {
  return React.useMemo(() => {
    const perBody = new Map<string, Set<string>>();
    const eyeCells = new Set<string>();
    for (const shape of MOSAIC_SHAPES) {
      // A fixed seed per body: `mosaicGeometry` mirrors and bands from `shapeSeed`, so the facts
      // would otherwise describe one *rendering* of the silhouette rather than the silhouette. The
      // face set draws with the same seed, which is what lets its fit check and this agree.
      const geometry = mosaicGeometry({ ...seedIdentity('face-body'), shapeName: shape.name });
      perBody.set(shape.name, new Set(geometry.cells.map((cell) => cellKey(cell.x, cell.y))));
      for (const eye of geometry.eyes) {
        // Width 2 in the resting face: a pixel on either half of the white of the eye is on the eye.
        eyeCells.add(cellKey(eye.x, eye.y));
        eyeCells.add(cellKey(eye.x + 1, eye.y));
      }
    }
    const anywhere = new Set<string>();
    for (const set of perBody.values()) for (const id of set) anywhere.add(id);
    const universal = new Set([...anywhere].filter((id) => [...perBody.values()].every((set) => set.has(id))));
    return { universal, anywhere, eyeCells, perBody, bodyCells: perBody.get('tuft') ?? new Set<string>() };
  }, []);
}

/**
 * The cells a drawing would float past on a given body.
 *
 * Pure, so the face set can call it while rendering a card without mounting a hook — a grid of
 * sixteen cards each computing six body sets would be six times the work of the one shared facts
 * object, for an answer that only changes when the art does.
 *
 * Rows 0 and 13 have no cells on any body, so a brim drawn there is *reported* rather than forbidden:
 * the renderer's grid group (`translate(8 1) scale(7)`) puts those rows on screen, floating clear of
 * the silhouette. That is sometimes the intent, which is why this returns evidence, not a veto.
 */
export const pixelsOffBody = <T extends { x: number; y: number }>(
  pixels: readonly T[],
  facts: Pick<GridFacts, 'perBody'>,
  shapeName: string,
): T[] => {
  const cells = facts.perBody.get(shapeName);
  if (!cells) return [];
  return pixels.filter((pixel) => !cells.has(cellKey(pixel.x, pixel.y)));
};
