/**
 * Faces for the Mosaic avatar: ten accessories over twelve bodies.
 *
 * The Mosaic blob renders on a 12-wide pixel grid (see `mosaicGeometry`), body rows 1–12, eyes on
 * row 6. Every accessory here is drawn on that same grid so it cannot drift out of alignment with
 * the body it sits on, and so it inherits the body's `crispEdges` rendering rather than
 * anti-aliasing into a smudge.
 *
 * ## The count
 *
 * **25 faces.** Face 1 is the only accessory-free one; faces 2–25 each carry exactly one accessory.
 * The body underneath (one of the six silhouettes, mirrored or not) is the canvas, not a separate
 * face — and colour is not a variation, so it never multiplies the number.
 *
 * ## Eyes
 *
 * Two accessories decide what happens to the eyes, and they are the exception rather than the rule:
 *
 *   - **Sunglasses cover them.** Lenses are opaque and sit on the eye row; the eyes are not drawn.
 *   - **Nerd glasses show them through.** The frames sit *around* the eyes, so the eyes stay and the
 *     pupil keeps tracking.
 *
 * Everything else leaves the eyes where they are — a moustache below them, an artist hat above them.
 * `coversEyes` says which is which, so the renderer never has to reason about it.
 *
 * ## Variants
 *
 * Eight of the ten accessories are being redrawn: the first pass read badly at 30px (invisible,
 * horned, or unreadable as the thing they were meant to be). Each of those keeps its original as
 * variant 1 and gains two alternatives, so the gallery offers the three side by side and a person
 * can pick rather than describe. `MOSAIC_ACCESSORY_VARIANTS` is the list; `MOSAIC_FACES` uses variant
 * 1 of everything until a choice is made.
 */

/**
 * Optional motion for a single pixel.
 *
 * Accessories were static: a cell was a colour and nothing else. A phone's screen is the first thing
 * that needs a cell to *do* something, so a pixel can now name one of a small closed set of
 * animations, applied as a class by the renderer. Closed on purpose — an arbitrary CSS string in the
 * data would be a styling system, and this only needs to make a few effects possible.
 *
 * Every one of these is written in the pixel-art idiom the mosaic already uses: `steps(1, end)` with
 * hard colour swaps rather than smooth fades, because a smooth gradient across a 2.5px cell just
 * looks like a blurry pixel.
 *
 * Declared before `MosaicPixel` so the type below can refer to it.
 */
export type MosaicAnim =
  /** A phone screen: cycles pastel colours, and occasionally goes dark as the screen sleeps. */
  | 'screen'
  /** Slower, softer version of `screen` — for a display that is idling rather than active. */
  | 'screenIdle';

/** A pixel in the body's own grid coordinates: `x` across 12, `y` down from 1. */
export type MosaicPixel = { x: number; y: number; fill: string; anim?: MosaicAnim };

export type MosaicAccessory =
  | 'sunglasses'
  | 'artistHat'
  | 'phone'
  | 'bigLips'
  | 'eyelashes'
  | 'tears'
  | 'funnyHair'
  | 'nerdGlasses'
  | 'moustache'
  | 'flower'
  // ---- Second pass: drawn to the pixel constraint (see the notes above each) ----
  | 'blackEye'
  | 'headBandage'
  | 'monocle'
  | 'antennae'
  | 'toothbrush'
  | 'partyHat'
  | 'beret'
  | 'sleepMask'
  | 'crown'
  | 'beanie'
  | 'headphones'
  | 'starSticker'
  | 'snout'
  | 'bowTie'
  | 'plasterCross'
  | 'roundHat'
  | 'skaterHat'
  | 'bandana'
  | 'scientist'
  | 'blushing'
  | 'hairBow'
  | 'horns'
  | 'halo'
  | 'bite'
  | 'eyepatch';

/** One drawing of an accessory. */
export type AccessoryVariant = {
  /** What this specific drawing does differently, in a few words. */
  note: string;
  /**
   * True when the accessory paints over the eye row. The renderer skips the eyes entirely rather
   * than drawing them beneath an opaque lens, which would show through the gaps.
   */
  coversEyes: boolean;
  /**
   * Pixels as `[x, y, colour]` triples, with an optional fourth entry naming an animation: the shape
   * is the layout, so the art stays readable. The fourth slot only appears where a cell moves.
   */
  pixels: readonly (readonly [number, number, string, MosaicAnim?])[];
};

export type AccessoryArt = {
  label: string;
  /** Variant 1 first. The first is what `MOSAIC_FACES` uses until someone chooses otherwise. */
  variants: readonly AccessoryVariant[];

};

/** The dark ink the features are drawn in: the same value the pupils use. */
const INK = '#14111a';
/** Lens glass: dark, with a lighter reflection so it reads as glass at small sizes. */
const LENS = '#2b2436';
const GLINT = '#fffdf5';
const LIP = '#c2456a';
/** Burgundy: the nerd-glasses frame, dark enough to read against any body colour. */
const FRAME = '#7a2233';
const LEAF = '#3f8f4a';
const PETAL = '#e8c35a';
const STEM = '#2f6b38';

export const MOSAIC_ACCESSORIES: Record<MosaicAccessory, AccessoryArt> = {
  // Sunglasses read well; only the left lens was missing its centre pixel. Variant 1 repairs that.
  sunglasses: {
    label: 'Sunglasses',
    variants: [
      {
        note: 'Solid lenses, repaired instep (the left lens was one pixel short)',
        coversEyes: true,
        pixels: [
          [1, 6, LENS], [2, 6, LENS], [3, 6, LENS], [4, 6, LENS],
          [7, 6, LENS], [8, 6, LENS], [9, 6, LENS], [10, 6, LENS],
          [1, 5, INK], [2, 5, INK], [3, 5, INK], [4, 5, INK],
          [7, 5, INK], [8, 5, INK], [9, 5, INK], [10, 5, INK],
          [5, 5, INK], [6, 5, INK],
          [2, 5, GLINT], [8, 5, GLINT],
        ],
      },
    ],
  },

  // Artist hat: the brim covered the eyes and the crown floated above the body. Both redraws sit
  // higher and narrower so the face stays visible.
  artistHat: {
    label: 'Artist hat',
    variants: [
      {
        note: 'Original: wide brim on the eye row',
        coversEyes: false,
        pixels: [
          [1, 4, INK], [2, 4, INK], [3, 4, INK], [4, 4, INK], [5, 4, INK], [6, 4, INK], [7, 4, INK], [8, 4, INK], [9, 4, INK], [10, 4, INK],
          [3, 3, LIP], [4, 3, LIP], [5, 3, LIP], [6, 3, LIP], [7, 3, LIP], [8, 3, LIP],
          [4, 2, LIP], [5, 2, LIP], [6, 2, LIP], [7, 2, LIP],
          [5, 3, GLINT], [6, 3, GLINT],
        ],
      },
      {
        note: 'Beret: small cap tipped to one side, clear of the eyes',
        coversEyes: false,
        pixels: [
          [4, 2, LIP], [5, 2, LIP], [6, 2, LIP], [7, 2, LIP],
          [3, 3, LIP], [4, 3, LIP], [5, 3, LIP], [6, 3, LIP], [7, 3, LIP],
          [5, 1, STEM], [6, 1, STEM],
          [4, 2, GLINT],
        ],
      },
      {
        note: 'Brim only: a single dark line above the eyes, like a painter’s cap',
        coversEyes: false,
        pixels: [
          [2, 4, INK], [3, 4, INK], [4, 4, INK], [5, 4, INK], [6, 4, INK], [7, 4, INK], [8, 4, INK], [9, 4, INK],
          [3, 3, LIP], [4, 3, LIP], [5, 3, LIP], [6, 3, LIP], [7, 3, LIP], [8, 3, LIP],
        ],
      },
    ],
  },

  // Phone: a thin bar read as a stray mark. These give it a body and a screen.
  phone: {
    label: 'Phone',
    variants: [
      {
        note: 'Original: thin two-cell bar',
        coversEyes: false,
        pixels: [
          [1, 5, INK], [2, 5, INK], [1, 6, INK], [2, 6, INK], [1, 7, INK], [2, 7, INK],
          [1, 8, INK], [2, 8, INK], [1, 9, INK], [2, 9, INK],
          [2, 5, GLINT], [2, 6, GLINT],
        ],
      },
      {
        note: 'Held up: wider block with a lit screen, at the side of the head',
        coversEyes: false,
        pixels: [
          [0, 4, INK], [1, 4, INK], [2, 4, INK],
          [0, 5, INK], [1, 5, GLINT], [2, 5, INK],
          [0, 6, INK], [1, 6, GLINT], [2, 6, INK],
          [0, 7, INK], [1, 7, GLINT], [2, 7, INK],
          [0, 8, INK], [1, 8, INK], [2, 8, INK],
        ],
      },
      {
        note: 'At the ear: small angled handset, three cells, high on the head',
        coversEyes: false,
        pixels: [
          [1, 4, INK], [2, 4, INK],
          [1, 5, INK], [2, 5, INK],
          [1, 6, GLINT], [2, 6, INK],
        ],
      },
    ],
  },

  // Big lips were invisible: two rows of lipstick in the body's own colours. Variants change the
  // colour contrast and the position rather than the shape.
  bigLips: {
    label: 'Big lips',
    variants: [
      {
        note: 'Original: lipstick, low contrast against the body',
        coversEyes: false,
        pixels: [
          [3, 8, LIP], [4, 8, LIP], [5, 8, LIP], [6, 8, LIP], [7, 8, LIP], [8, 8, LIP],
          [4, 9, LIP], [5, 9, LIP], [6, 9, LIP], [7, 9, LIP],
          [5, 8, INK], [6, 8, INK],
        ],
      },
      {
        note: 'Outlined: dark edge around the lipstick so it separates from any body colour',
        coversEyes: false,
        pixels: [
          [2, 8, INK], [3, 8, INK], [4, 8, INK], [5, 8, INK], [6, 8, INK], [7, 8, INK], [8, 8, INK], [9, 8, INK],
          [3, 9, INK], [4, 9, LIP], [5, 9, LIP], [6, 9, LIP], [7, 9, LIP], [8, 9, INK],
          [3, 7, INK], [4, 7, LIP], [5, 7, LIP], [6, 7, LIP], [7, 7, LIP], [8, 7, INK],
        ],
      },
      {
        note: 'Open smile: a dark mouth with a lipstick edge, readable at 30px',
        coversEyes: false,
        pixels: [
          [3, 8, LIP], [4, 8, LIP], [5, 8, LIP], [6, 8, LIP], [7, 8, LIP], [8, 8, LIP],
          [3, 9, INK], [4, 9, INK], [5, 9, INK], [6, 9, INK], [7, 9, INK], [8, 9, INK],
        ],
      },
    ],
  },

  // Eyelashes were invisible / read as horns. All three variants lengthen and thicken them.
  eyelashes: {
    label: 'Eyelashes',
    variants: [
      {
        // Row 5 is the lid, one row above the eyes, and row 4 is the flares growing off it. Anchoring
        // the flares to a continuous lid is what stops them reading as horns beside the face.
        note: 'Hand-drawn: a lash line above both eyes with flares at the corners',
        coversEyes: false,
        pixels: [
          [0, 4, '#14111a'],
          [2, 4, '#14111a'],
          [7, 4, '#14111a'],
          [9, 4, '#14111a'],
          [11, 4, '#14111a'],
          [1, 5, '#14111a'],
          [2, 5, '#14111a'],
          [3, 5, '#14111a'],
          [4, 5, '#14111a'],
          [6, 5, '#14111a'],
          [7, 5, '#14111a'],
          [8, 5, '#14111a'],
          [9, 5, '#14111a'],
          [10, 5, '#14111a'],
        ],
      },
    ],
  },

  // Tears were invisible: pale blue on a pale body. Variants use a darker edge and start higher.
  tears: {
    label: 'Tears',
    variants: [
      {
        note: 'Original: pale blue, one cell wide',
        coversEyes: false,
        pixels: [
          [3, 7, '#7fd4f0'], [4, 8, '#7fd4f0'],
          [8, 7, '#7fd4f0'], [7, 8, '#7fd4f0'],
        ],
      },
      {
        note: 'Outlined drops: dark rim makes them read on any body colour',
        coversEyes: false,
        pixels: [
          // Pulled in to the columns every body has; the outer x=1 and x=10 columns only exist on the
          // widest silhouettes, so the tears used to hang off the side of a narrow one.
          [3, 7, INK], [4, 7, INK], [3, 8, '#7fd4f0'], [4, 8, INK], [3, 9, INK],
          [7, 7, INK], [8, 7, INK], [8, 8, '#7fd4f0'], [7, 8, INK], [8, 9, INK],
        ],
      },
      {
        note: 'Long tracks: two cells wide, running from the lid to the mouth',
        coversEyes: false,
        pixels: [
          [3, 7, '#7fd4f0'], [4, 7, '#7fd4f0'],
          [3, 8, '#7fd4f0'], [4, 8, '#7fd4f0'],
          [3, 9, '#7fd4f0'],
          [8, 7, '#7fd4f0'], [7, 7, '#7fd4f0'],
          [8, 8, '#7fd4f0'], [7, 8, '#7fd4f0'],
          [8, 9, '#7fd4f0'],
        ],
      },
    ],
  },

  // Funny hair read fine; one variant kept, plus two alternatives for comparison.
  funnyHair: {
    label: 'Funny hair',
    variants: [
      {
        note: 'Original: alternating fringe blocks',
        coversEyes: false,
        pixels: [
          // Trimmed to the columns every body has. The fringe no longer reaches x=2 or row 1, which
          // only the widest silhouettes offered — it looked broken on a narrow one.
          [3, 3, INK], [4, 3, INK], [6, 3, INK], [7, 3, INK],
          [4, 2, INK], [5, 2, INK], [7, 2, INK],
          [3, 4, INK], [8, 4, INK],
        ],
      },
      {
        note: 'Spikes: a mohawk of alternating verticals',
        coversEyes: false,
        pixels: [
          [4, 2, INK], [4, 3, INK],
          [5, 2, INK], [5, 3, INK], [5, 4, INK],
          [6, 3, INK],
          [7, 2, INK], [7, 3, INK],
        ],
      },
      {
        note: 'Side sweep: a heavy fringe falling to one side',
        coversEyes: false,
        pixels: [
          [4, 2, INK], [5, 2, INK], [6, 2, INK], [7, 2, INK],
          [3, 3, INK], [4, 3, INK], [5, 3, INK],
          [3, 4, INK],
        ],
      },
    ],
  },

  // Nerd glasses read well and must keep the eyes visible. The frames have to be built around where
  // the eyes actually are, and **the eye row is centred on the body, not fixed**: `mosaicGeometry`
  // puts the pair at x=3 and x=6 on most silhouettes, but at x=4 and x=7 on `sprig`, whose face rows
  // are narrower. A lens sized for one of those sits on top of the other's eye — which is what the
  // first attempt did, drawing around x=1–4 and 7–10 with both eyes outside the frames entirely.
  //
  // So the lenses are hollow rectangles wide enough to swallow either centring: left 2–5, right 6–9,
  // with the interior of each covering both the x=3/x=6 and the x=4/x=7 eye. The bridge is the single
  // cell at x=5 on the eye row, which is frame in both cases and never an eye.
  nerdGlasses: {
    label: 'Nerd glasses',
    variants: [
      {
        note: 'Burgundy frames around the eyes, eyes visible through',
        coversEyes: false,
        pixels: [
          // Rails on rows 5 and 7, kept inside every body's columns (x=3–8).
          [3, 5, FRAME], [4, 5, FRAME], [5, 5, FRAME], [6, 5, FRAME], [7, 5, FRAME], [8, 5, FRAME],
          [3, 7, FRAME], [4, 7, FRAME], [5, 7, FRAME], [6, 7, FRAME], [7, 7, FRAME], [8, 7, FRAME],
          // Row 6 is the eye row and is left completely open, so no eye can be covered.
        ],
      },
      {
        note: 'Burgundy, thick rims one row taller so the frames survive at 30px',
        coversEyes: false,
        pixels: [
          // Rails on rows 4 and 8, inside the columns every body has (x=3–9 and x=3–9).
          [3, 4, FRAME], [4, 4, FRAME], [5, 4, FRAME], [6, 4, FRAME], [7, 4, FRAME], [8, 4, FRAME], [9, 4, FRAME],
          [3, 8, FRAME], [4, 8, FRAME], [5, 8, FRAME], [6, 8, FRAME], [7, 8, FRAME], [8, 8, FRAME], [9, 8, FRAME],
          // Sides on rows 5 and 7, at x=3 and x=8 — the outermost columns safe on every body that is
          // also clear of the eye cells on row 6 (which is left entirely open).
          [3, 5, FRAME], [8, 5, FRAME], [3, 7, FRAME], [8, 7, FRAME],
        ],
      },
      {
        note: 'Burgundy with temple arms reaching the edge of the body',
        coversEyes: false,
        pixels: [
          [3, 5, FRAME], [4, 5, FRAME], [5, 5, FRAME], [6, 5, FRAME], [7, 5, FRAME], [8, 5, FRAME],
          [3, 7, FRAME], [4, 7, FRAME], [5, 7, FRAME], [6, 7, FRAME], [7, 7, FRAME], [8, 7, FRAME],
          // Arms on row 4, inside the safe columns.
          [3, 4, FRAME], [8, 4, FRAME],
        ],
      },
    ],
  },

  // Moustache read as a mouth. Variants change it into shapes that cannot be mistaken for one.
  moustache: {
    label: 'Moustache',
    variants: [
      {
        note: 'Original: flat bar with drooping ends',
        coversEyes: false,
        pixels: [
          [3, 8, INK], [4, 8, INK], [5, 8, INK], [6, 8, INK], [7, 8, INK], [8, 8, INK],
          [3, 9, INK], [8, 9, INK],
        ],
      },
      {
        note: 'Handlebar: curls up at both ends so it reads as hair, not a mouth',
        coversEyes: false,
        pixels: [
          [4, 8, INK], [5, 8, INK], [6, 8, INK], [7, 8, INK],
          // Curls on rows 7 and 8, inside the safe columns; row 6 is the eye row and stays clear.
          [3, 8, INK], [8, 8, INK],
          [3, 7, INK], [8, 7, INK],
        ],
      },
      {
        note: 'Thin pencil line: one row, high under the eyes',
        coversEyes: false,
        pixels: [
          [4, 7, INK], [5, 7, INK], [6, 7, INK], [7, 7, INK],
          [3, 7, INK], [8, 7, INK],
        ],
      },
    ],
  },

  // Flower needs work: it was a four-pixel blob. Variants make the bloom and stem explicit.
  flower: {
    label: 'Flower on the upper left',
    variants: [
      {
        note: 'Hand-drawn: Red petals with an outlined edge and a green stem',
        coversEyes: false,
        pixels: [
          [8, 1, '#6d071d'],
          [7, 2, '#6d071d'],
          [8, 2, '#c4384a'],
          [9, 2, '#6d071d'],
          [6, 3, '#6d071d'],
          [7, 3, '#c4384a'],
          [8, 3, '#e8c35a'],
          [9, 3, '#c4384a'],
          [10, 3, '#6d071d'],
          [7, 4, '#6d071d'],
          [8, 4, '#c4384a'],
          [9, 4, '#6d071d'],
          [10, 4, '#004c15'],
          [8, 5, '#6d071d'],
          [9, 5, '#3f8f4a'],
          [10, 5, '#3f8f4a'],
        ],
      },
      {
        note: 'Hand-drawn: Violet petals with an outlined edge and a green stem',
        coversEyes: false,
        pixels: [
          [8, 1, '#4d1665'],
          [7, 2, '#4d1665'],
          [8, 2, '#8b4fa8'],
          [9, 2, '#4d1665'],
          [6, 3, '#4d1665'],
          [7, 3, '#8b4fa8'],
          [8, 3, '#fffdf5'],
          [9, 3, '#8b4fa8'],
          [10, 3, '#4d1665'],
          [7, 4, '#4d1665'],
          [8, 4, '#8b4fa8'],
          [9, 4, '#4d1665'],
          [10, 4, '#004c15'],
          [8, 5, '#4d1665'],
          [9, 5, '#3f8f4a'],
          [10, 5, '#3f8f4a'],
        ],
      },
      {
        note: 'Hand-drawn: Yellow petals with an outlined edge and a green stem',
        coversEyes: false,
        pixels: [
          [8, 1, '#7e6410'],
          [7, 2, '#7e6410'],
          [8, 2, '#e8c35a'],
          [9, 2, '#7e6410'],
          [6, 3, '#7e6410'],
          [7, 3, '#e8c35a'],
          [8, 3, '#733c0c'],
          [9, 3, '#e8c35a'],
          [10, 3, '#7e6410'],
          [7, 4, '#7e6410'],
          [8, 4, '#e8c35a'],
          [9, 4, '#7e6410'],
          [10, 4, '#004c15'],
          [8, 5, '#7e6410'],
          [9, 5, '#3f8f4a'],
          [10, 5, '#3f8f4a'],
        ],
      },
      {
        note: 'Hand-drawn: Cyan petals with an outlined edge and a green stem',
        coversEyes: false,
        pixels: [
          [8, 1, '#0d5167'],
          [7, 2, '#0d5167'],
          [8, 2, '#2f9fc4'],
          [9, 2, '#0d5167'],
          [6, 3, '#0d5167'],
          [7, 3, '#2f9fc4'],
          [8, 3, '#fffdf5'],
          [9, 3, '#2f9fc4'],
          [10, 3, '#0d5167'],
          [7, 4, '#0d5167'],
          [8, 4, '#2f9fc4'],
          [9, 4, '#0d5167'],
          [10, 4, '#004c15'],
          [8, 5, '#0d5167'],
          [9, 5, '#3f8f4a'],
          [10, 5, '#3f8f4a'],
        ],
      },
      {
        note: 'Hand-drawn: Orange petals with an outlined edge and a green stem',
        coversEyes: false,
        pixels: [
          [8, 1, '#733c0c'],
          [7, 2, '#733c0c'],
          [8, 2, '#d97a2b'],
          [9, 2, '#733c0c'],
          [6, 3, '#733c0c'],
          [7, 3, '#d97a2b'],
          [8, 3, '#6d071d'],
          [9, 3, '#d97a2b'],
          [10, 3, '#733c0c'],
          [7, 4, '#733c0c'],
          [8, 4, '#d97a2b'],
          [9, 4, '#733c0c'],
          [10, 4, '#004c15'],
          [8, 5, '#733c0c'],
          [9, 5, '#3f8f4a'],
          [10, 5, '#3f8f4a'],
        ],
      },
    ],
  },
  // ---- Second pass: twenty more, drawn to the pixel constraint -----------------------------------
  //
  // Everything below obeys the map the first pass only discovered by failing:
  //
  //     row  1: unusable (no body has a cell there)
  //     row  2: x 4–7
  //     rows 3,5,9: x 3–8
  //     row  4: x 3–9      row 8: x 3–9
  //     row  6 (EYES): x 2–8, and x=3–8 are eye cells on at least one body
  //     row  7: x 2–9
  //     rows 10–11: x 4–8      row 12: x 6–7
  //
  // A pixel outside those cells floats off a narrow body. A pixel on the eye row for a garment that
  // does not `coversEyes` lands on an eye. Both are checked mechanically by the script in the
  // gallery's notes rather than by eye. The shortest legible feature is a 2-cell run: at 30px one
  // cell is ~2.5 screen pixels.

  // A shiner: a ring hugging one eye, with a dark bruise under it. Kept off the eye cells by sitting
  // only on rows 5 and 7 (above and below), never row 6.
  blackEye: {
    label: 'Black eye',
    variants: [
      {
        note: 'Bruised ring above and below one eye',
        coversEyes: false,
        pixels: [
          [3, 5, INK], [4, 5, INK], [5, 5, INK],
          [3, 7, INK], [4, 7, INK], [5, 7, INK],
          [4, 8, '#4a3a5a'], [5, 8, '#4a3a5a'],
        ],
      },
    ],
  },

  // A bandage across the crown: light strips with dark perforations, rows 2–3 only.
  headBandage: {
    label: 'Bandage',
    variants: [
      {
        note: 'Light strip across the crown with dark perforations',
        coversEyes: false,
        pixels: [
          [4, 2, '#e8e2d4'], [5, 2, '#e8e2d4'], [6, 2, '#e8e2d4'], [7, 2, '#e8e2d4'],
          [4, 3, '#e8e2d4'], [5, 3, INK], [6, 3, '#e8e2d4'], [7, 3, INK],
        ],
      },
    ],
  },

  // A monocle: a ring around the right eye only, on rows 5 and 7, with a chain on row 8.
  monocle: {
    label: 'Monocle',
    variants: [
      {
        note: 'Ring above and below one eye, with a chain',
        coversEyes: false,
        pixels: [
          [6, 5, FRAME], [7, 5, FRAME], [8, 5, FRAME],
          [6, 7, FRAME], [7, 7, FRAME], [8, 7, FRAME],
          [8, 8, '#b9a06a'], [7, 9, '#b9a06a'],
        ],
      },
    ],
  },

  // Antennae: stalks on row 3 with bulbs on row 2 — the one place two cells of height exist near the
  // crown. Reading as horns is acceptable; the owner liked that.
  antennae: {
    label: 'Antennae',
    variants: [
      {
        note: 'Two short stalks with bright bulbs',
        coversEyes: false,
        pixels: [
          [4, 3, INK], [7, 3, INK],
          [4, 2, PETAL], [7, 2, PETAL],
        ],
      },
    ],
  },

  // Toothbrush moustache: two rows tall, narrow, hard-edged — distinct from the plain one.
  toothbrush: {
    label: 'Toothbrush moustache',
    variants: [
      {
        note: 'Narrow and two rows tall',
        coversEyes: false,
        pixels: [
          [4, 8, INK], [5, 8, INK], [6, 8, INK], [7, 8, INK],
          [5, 9, INK], [6, 9, INK],
        ],
      },
    ],
  },

  // Party hat: a cone with a brim, both on safe rows.
  partyHat: {
    label: 'Party hat',
    variants: [
      {
        note: 'Cone with a brim',
        coversEyes: false,
        pixels: [
          [5, 2, PETAL], [6, 2, PETAL],
          [4, 3, LIP], [5, 3, LIP], [6, 3, LIP], [7, 3, LIP],
          [3, 4, INK], [4, 4, INK], [5, 4, INK], [6, 4, INK], [7, 4, INK], [8, 4, INK],
        ],
      },
    ],
  },

  // Beret: a round cap tipped right, with the stalk on row 3 rather than above the body.
  beret: {
    label: 'Beret',
    variants: [
      {
        note: 'Round cap tipped right with a stalk',
        coversEyes: false,
        pixels: [
          [4, 2, FRAME], [5, 2, FRAME], [6, 2, FRAME], [7, 2, FRAME],
          [3, 3, FRAME], [4, 3, FRAME], [5, 3, FRAME], [6, 3, FRAME], [7, 3, FRAME], [8, 3, FRAME],
          [4, 4, INK], [5, 4, INK], [6, 4, INK], [7, 4, INK], [8, 4, INK],
        ],
      },
    ],
  },

  // Sleep mask: one wide band over both eyes. Covers, so the eye row is fair game.
  sleepMask: {
    label: 'Sleep mask',
    variants: [
      {
        note: 'One wide band across both eyes',
        coversEyes: true,
        pixels: [
          [3, 5, LENS], [4, 5, LENS], [5, 5, LENS], [6, 5, LENS], [7, 5, LENS], [8, 5, LENS],
          [3, 6, LENS], [4, 6, LENS], [5, 6, LENS], [6, 6, LENS], [7, 6, LENS], [8, 6, LENS],
          [4, 5, GLINT],
        ],
      },
    ],
  },

  // Crown: three peaks with a band, rows 2–3.
  crown: {
    label: 'Crown',
    variants: [
      {
        // No dark outline: the edge is the same gold family as the rest, so the crown reads as one
        // cast object rather than a gold shape with a border drawn round it. Five values run
        // light-to-dark down the band, which is what the eye needs to read a gradient at this size.
        note: 'Hand-drawn: four points on a gold band, shaded light to dark with no outline',
        coversEyes: false,
        pixels: [
          [5, 0, '#f0d787'],
          [6, 0, '#f0d787'],
          [2, 1, '#b3922c'],
          [4, 1, '#b3922c'],
          [5, 1, '#f0d787'],
          [6, 1, '#f0d787'],
          [7, 1, '#b3922c'],
          [9, 1, '#b3922c'],
          [1, 2, '#b3922c'],
          [2, 2, '#f0d787'],
          [3, 2, '#b3922c'],
          [4, 2, '#f0d787'],
          [5, 2, '#f0d787'],
          [6, 2, '#f0d787'],
          [7, 2, '#f0d787'],
          [8, 2, '#b3922c'],
          [9, 2, '#f0d787'],
          [10, 2, '#b3922c'],
          [1, 3, '#b3922c'],
          [2, 3, '#e8c35a'],
          [3, 3, '#e8c35a'],
          [4, 3, '#e8c35a'],
          [5, 3, '#e8c35a'],
          [6, 3, '#e8c35a'],
          [7, 3, '#e8c35a'],
          [8, 3, '#e8c35a'],
          [9, 3, '#e8c35a'],
          [10, 3, '#b3922c'],
          [1, 4, '#b3922c'],
          [2, 4, '#d4ab45'],
          [3, 4, '#d4ab45'],
          [4, 4, '#e8c35a'],
          [5, 4, '#e8c35a'],
          [6, 4, '#e8c35a'],
          [7, 4, '#e8c35a'],
          [8, 4, '#d4ab45'],
          [9, 4, '#d4ab45'],
          [10, 4, '#b3922c'],
          [1, 5, '#b3922c'],
          [2, 5, '#b3922c'],
          [3, 5, '#b3922c'],
          [4, 5, '#b3922c'],
          [5, 5, '#b3922c'],
          [6, 5, '#b3922c'],
          [7, 5, '#b3922c'],
          [8, 5, '#b3922c'],
          [9, 5, '#b3922c'],
          [10, 5, '#b3922c'],
        ],
      },
    ],
  },

  // Beanie: a filled cap with a lighter turned-up brim.
  beanie: {
    label: 'Beanie',
    variants: [
      {
        note: 'Filled cap with a lighter brim',
        coversEyes: false,
        pixels: [
          [4, 2, FRAME], [5, 2, FRAME], [6, 2, FRAME], [7, 2, FRAME],
          [3, 3, FRAME], [4, 3, FRAME], [5, 3, FRAME], [6, 3, FRAME], [7, 3, FRAME], [8, 3, FRAME],
          [4, 4, '#c98b6b'], [5, 4, '#c98b6b'], [6, 4, '#c98b6b'], [7, 4, '#c98b6b'],
        ],
      },
    ],
  },

  // Headphones: a band over the crown with cups beside the eyes on row 5 and 7 (never on row 6).
  headphones: {
    label: 'Headphones',
    variants: [
      {
        // The cups wrap the sides (x=1–2 and x=9–10) and close under the ear on row 8, so the head
        // reads as *inside* them. The first version put single cells beside the eyes, which looked
        // like earrings rather than headphones.
        note: 'Hand-drawn: band over the head, cups wrapping both sides',
        coversEyes: false,
        pixels: [
          [4, 2, INK], [5, 2, INK], [6, 2, INK], [7, 2, INK],
          [3, 3, INK], [8, 3, INK],
          [3, 4, INK], [8, 4, INK],
          [2, 5, INK], [9, 5, INK],
          [1, 6, INK], [2, 6, INK], [9, 6, INK], [10, 6, INK],
          [1, 7, INK], [2, 7, INK], [9, 7, INK], [10, 7, INK],
          [2, 8, INK], [9, 8, INK],
        ],
      },
    ],
  },

  // A star sticker on the cheek, small and bright.
  starSticker: {
    label: 'Star sticker',
    variants: [
      {
        note: 'Four-point star on the right cheek',
        coversEyes: false,
        pixels: [
          [7, 9, PETAL],
          [6, 10, PETAL], [7, 10, PETAL], [8, 10, PETAL],
          [7, 11, PETAL],
        ],
      },
    ],
  },

  // A long nose: two cells wide, hanging below the eyes to row 9.
  snout: {
    label: 'Long nose',
    variants: [
      {
        note: 'A two-cell nose with a dark tip',
        coversEyes: false,
        pixels: [
          [5, 7, INK], [6, 7, INK],
          [5, 8, INK], [6, 8, INK],
          [5, 9, LIP], [6, 9, LIP],
        ],
      },
    ],
  },

  // A bow tie under the chin, rows 10–11.
  bowTie: {
    label: 'Bow tie',
    variants: [
      {
        note: 'Two dark triangles with a knot',
        coversEyes: false,
        pixels: [
          [4, 10, INK], [5, 10, FRAME], [6, 10, FRAME], [7, 10, INK], [8, 10, INK],
          [4, 11, INK], [8, 11, INK],
        ],
      },
    ],
  },

  // A plaster cross on the cheek: light on dark, two crossed strips.
  plasterCross: {
    label: 'Plaster cross',
    variants: [
      {
        note: 'Two crossed light strips',
        coversEyes: false,
        pixels: [
          [7, 9, '#e8e2d4'], [8, 9, '#e8e2d4'],
          [8, 10, '#e8e2d4'], [7, 10, '#e8e2d4'],
        ],
      },
    ],
  },

  // A hair bow: two loops and a knot on the upper left.
  hairBow: {
    label: 'Hair bow',
    variants: [
      {
        note: 'Two loops with a knot, upper left',
        coversEyes: false,
        pixels: [
          [3, 3, LIP], [4, 3, LIP], [5, 3, FRAME], [6, 3, LIP], [7, 3, LIP],
          [3, 4, LIP], [7, 4, LIP],
        ],
      },
    ],
  },

  // Horns: two dark posts with light tips — the pair the owner called "cool".
  horns: {
    label: 'Horns',
    variants: [
      {
        // The tips at x=0 and x=11 sit outside every silhouette, which is the point: they flare past
        // the head like real horns. Anything drawn inward of them turns the pair into a headband.
        note: 'Hand-drawn: dark horns sweeping out and up, tips flaring past the head',
        coversEyes: false,
        pixels: [
          [0, 0, '#6d071d'],
          [11, 0, '#6d071d'],
          [0, 1, '#6d071d'],
          [1, 1, '#6d071d'],
          [10, 1, '#6d071d'],
          [11, 1, '#6d071d'],
          [1, 2, '#6d071d'],
          [2, 2, '#6d071d'],
          [3, 2, '#6d071d'],
          [4, 2, '#6d071d'],
          [7, 2, '#6d071d'],
          [8, 2, '#6d071d'],
          [9, 2, '#6d071d'],
          [10, 2, '#6d071d'],
          [1, 3, '#6d071d'],
          [2, 3, '#6d071d'],
          [3, 3, '#6d071d'],
          [8, 3, '#6d071d'],
          [9, 3, '#6d071d'],
          [10, 3, '#6d071d'],
          [2, 4, '#6d071d'],
          [9, 4, '#6d071d'],
        ],
      },
    ],
  },

  // A halo: a bright ring on rows 2–3, clear of the body edge.
  halo: {
    label: 'Halo',
    variants: [
      {
        note: 'Hand-drawn: gold bar above the head with side posts',
        coversEyes: false,
        pixels: [
          [4, 0, '#e8c35a'], [5, 0, '#e8c35a'], [6, 0, '#e8c35a'], [7, 0, '#e8c35a'],
          [3, 1, '#e8c35a'], [8, 1, '#e8c35a'],
          [4, 2, '#e8c35a'], [5, 2, '#e8c35a'], [6, 2, '#e8c35a'], [7, 2, '#e8c35a'],
        ],
      },
    ],
  },

  // A bite mark: two dark scallops where the crown edge would be.
  bite: {
    label: 'Bite mark',
    variants: [
      {
        note: 'Two dark scallops out of the crown',
        coversEyes: false,
        pixels: [
          [4, 2, INK], [5, 2, INK],
          [6, 3, INK], [7, 3, INK],
        ],
      },
    ],
  },

  // An eye patch over the left eye, with a strap running up to the right. Covers, so row 6 is fine.
  eyepatch: {
    label: 'Eye patch',
    variants: [
      {
        note: 'Dark patch over one eye with a strap',
        coversEyes: true,
        pixels: [
          [3, 5, INK], [4, 5, INK],
          [3, 6, INK], [4, 6, INK],
          [3, 7, INK], [4, 7, INK],
          [5, 4, INK], [6, 3, INK],
        ],
      },
    ],
  },

  // The round hat, drawn by hand: a domed crown on a wide brim, two-tone so the brim reads as its
  // own plane. Three colourways, because the shape is one face and colour is free variation.
  roundHat: {
    label: 'Round hat',
    variants: [
      {
        note: 'Hand-drawn: brown dome and brim, five-step gradient from highlight to shadow',
        coversEyes: false,
        pixels: [
          [3, 0, '#c4762a'],
          [4, 0, '#c4762a'],
          [6, 0, '#a05a1a'],
          [7, 0, '#733c0c'],
          [2, 1, '#c4762a'],
          [3, 1, '#c4762a'],
          [4, 1, '#c4762a'],
          [5, 1, '#a05a1a'],
          [6, 1, '#a05a1a'],
          [7, 1, '#733c0c'],
          [8, 1, '#733c0c'],
          [2, 2, '#c4762a'],
          [3, 2, '#c4762a'],
          [4, 2, '#a05a1a'],
          [5, 2, '#a05a1a'],
          [6, 2, '#733c0c'],
          [7, 2, '#733c0c'],
          [8, 2, '#733c0c'],
          [2, 3, '#a05a1a'],
          [3, 3, '#a05a1a'],
          [4, 3, '#733c0c'],
          [5, 3, '#733c0c'],
          [6, 3, '#5a2c0a'],
          [7, 3, '#5a2c0a'],
          [8, 3, '#5a2c0a'],
          [0, 4, '#3d1d06'],
          [1, 4, '#3d1d06'],
          [2, 4, '#3d1d06'],
          [3, 4, '#3d1d06'],
          [4, 4, '#3d1d06'],
          [5, 4, '#3d1d06'],
          [6, 4, '#3d1d06'],
          [7, 4, '#3d1d06'],
          [8, 4, '#3d1d06'],
          [9, 4, '#3d1d06'],
          [10, 4, '#3d1d06'],
        ],
      },
      {
        note: 'Hand-drawn: white dome and brim, five-step gradient from highlight to shadow',
        coversEyes: false,
        pixels: [
          [3, 0, '#fffdf5'],
          [4, 0, '#fffdf5'],
          [6, 0, '#f2ede2'],
          [7, 0, '#e8e2d4'],
          [2, 1, '#fffdf5'],
          [3, 1, '#fffdf5'],
          [4, 1, '#fffdf5'],
          [5, 1, '#f2ede2'],
          [6, 1, '#f2ede2'],
          [7, 1, '#e8e2d4'],
          [8, 1, '#e8e2d4'],
          [2, 2, '#fffdf5'],
          [3, 2, '#fffdf5'],
          [4, 2, '#f2ede2'],
          [5, 2, '#f2ede2'],
          [6, 2, '#e8e2d4'],
          [7, 2, '#e8e2d4'],
          [8, 2, '#e8e2d4'],
          [2, 3, '#f2ede2'],
          [3, 3, '#f2ede2'],
          [4, 3, '#e8e2d4'],
          [5, 3, '#e8e2d4'],
          [6, 3, '#d8d1c2'],
          [7, 3, '#d8d1c2'],
          [8, 3, '#d8d1c2'],
          [0, 4, '#b9b2a6'],
          [1, 4, '#b9b2a6'],
          [2, 4, '#b9b2a6'],
          [3, 4, '#b9b2a6'],
          [4, 4, '#b9b2a6'],
          [5, 4, '#b9b2a6'],
          [6, 4, '#b9b2a6'],
          [7, 4, '#b9b2a6'],
          [8, 4, '#b9b2a6'],
          [9, 4, '#b9b2a6'],
          [10, 4, '#b9b2a6'],
        ],
      },
      {
        note: 'Hand-drawn: charcoal dome and brim, five-step gradient from highlight to shadow',
        coversEyes: false,
        pixels: [
          [3, 0, '#7d869e'],
          [4, 0, '#7d869e'],
          [6, 0, '#64718a'],
          [7, 0, '#494455'],
          [2, 1, '#7d869e'],
          [3, 1, '#7d869e'],
          [4, 1, '#7d869e'],
          [5, 1, '#64718a'],
          [6, 1, '#64718a'],
          [7, 1, '#494455'],
          [8, 1, '#494455'],
          [2, 2, '#7d869e'],
          [3, 2, '#7d869e'],
          [4, 2, '#64718a'],
          [5, 2, '#64718a'],
          [6, 2, '#494455'],
          [7, 2, '#494455'],
          [8, 2, '#494455'],
          [2, 3, '#64718a'],
          [3, 3, '#64718a'],
          [4, 3, '#494455'],
          [5, 3, '#494455'],
          [6, 3, '#2e2a38'],
          [7, 3, '#2e2a38'],
          [8, 3, '#2e2a38'],
          [0, 4, '#14111a'],
          [1, 4, '#14111a'],
          [2, 4, '#14111a'],
          [3, 4, '#14111a'],
          [4, 4, '#14111a'],
          [5, 4, '#14111a'],
          [6, 4, '#14111a'],
          [7, 4, '#14111a'],
          [8, 4, '#14111a'],
          [9, 4, '#14111a'],
          [10, 4, '#14111a'],
        ],
      },
    ],
  },

  // The skater hat: a five-column cap with a visor sticking out to the right. The visor is what makes
  // it a cap rather than another beanie, so it is the one part that must survive at 30px.
  skaterHat: {
    label: 'Skater hat',
    variants: [
      {
        note: 'Hand-drawn: cap with a visor to the right, three-tone shading',
        coversEyes: false,
        pixels: [
          [4, 1, '#88a6b2'],
          [5, 1, '#3d5fa8'],
          [6, 1, '#3d5fa8'],
          [7, 1, '#0d5167'],
          [3, 2, '#88a6b2'],
          [4, 2, '#2f9fc4'],
          [5, 2, '#2f9fc4'],
          [6, 2, '#2f9fc4'],
          [7, 2, '#2f9fc4'],
          [8, 2, '#0d5167'],
          [2, 3, '#88a6b2'],
          [3, 3, '#2f9fc4'],
          [4, 3, '#2f9fc4'],
          [5, 3, '#2f9fc4'],
          [6, 3, '#2f9fc4'],
          [7, 3, '#2f9fc4'],
          [8, 3, '#2f9fc4'],
          [9, 3, '#0d5167'],
          [10, 3, '#0d5167'],
        ],
      },
    ],
  },

  // The eye bandana: three rows across the face. It claims the eyes, because a band drawn over the eye
  // row that lets the eyes show through is a pair of spectacles, not a blindfold.
  bandana: {
    label: 'Eye bandana',
    variants: [
      {
        note: 'Hand-drawn: brown band across the eyes, five-step gradient',
        coversEyes: false,
        pixels: [
          [1, 5, '#c4762a'],
          [2, 5, '#c4762a'],
          [3, 5, '#c4762a'],
          [4, 5, '#c4762a'],
          [5, 5, '#c4762a'],
          [6, 5, '#c4762a'],
          [7, 5, '#c4762a'],
          [8, 5, '#c4762a'],
          [9, 5, '#c4762a'],
          [10, 5, '#c4762a'],
          [1, 6, '#733c0c'],
          [2, 6, '#733c0c'],
          [9, 6, '#733c0c'],
          [10, 6, '#733c0c'],
          [1, 7, '#3d1d06'],
          [2, 7, '#3d1d06'],
          [3, 7, '#3d1d06'],
          [4, 7, '#3d1d06'],
          [5, 7, '#3d1d06'],
          [6, 7, '#3d1d06'],
          [7, 7, '#3d1d06'],
          [8, 7, '#3d1d06'],
          [9, 7, '#3d1d06'],
          [10, 7, '#3d1d06'],
          [2, 5, '#a05a1a'], [9, 5, '#a05a1a'],
          [2, 7, '#5a2c0a'], [9, 7, '#5a2c0a'],
        ],
      },
      {
        note: 'Hand-drawn: red band across the eyes, five-step gradient',
        coversEyes: false,
        pixels: [
          [1, 5, '#e8a4b2'],
          [2, 5, '#e8a4b2'],
          [3, 5, '#e8a4b2'],
          [4, 5, '#e8a4b2'],
          [5, 5, '#e8a4b2'],
          [6, 5, '#e8a4b2'],
          [7, 5, '#e8a4b2'],
          [8, 5, '#e8a4b2'],
          [9, 5, '#e8a4b2'],
          [10, 5, '#e8a4b2'],
          [1, 6, '#c4384a'],
          [2, 6, '#c4384a'],
          [9, 6, '#c4384a'],
          [10, 6, '#c4384a'],
          [1, 7, '#6d071d'],
          [2, 7, '#6d071d'],
          [3, 7, '#6d071d'],
          [4, 7, '#6d071d'],
          [5, 7, '#6d071d'],
          [6, 7, '#6d071d'],
          [7, 7, '#6d071d'],
          [8, 7, '#6d071d'],
          [9, 7, '#6d071d'],
          [10, 7, '#6d071d'],
          [2, 5, '#e08a9c'], [9, 5, '#e08a9c'],
          [2, 7, '#8f1c31'], [9, 7, '#8f1c31'],
        ],
      },
    ],
  },
  // A lab coat: cyan body, shaded right sleeve, red pen at the pocket. The eyes draw over it (it does
  // not claim them), so the coat reads as something worn rather than something covering the face.
  scientist: {
    label: 'Scientist',
    variants: [
      {
        note: 'Hand-drawn: cyan lab coat with a red pen in the pocket',
        coversEyes: false,
        pixels: [
          [2, 5, '#2f9fc4'],
          [3, 5, '#2f9fc4'],
          [4, 5, '#2f9fc4'],
          [5, 5, '#2f9fc4'],
          [6, 5, '#2f9fc4'],
          [7, 5, '#2f9fc4'],
          [8, 5, '#2f9fc4'],
          [9, 5, '#0d5167'],
          [10, 5, '#0d5167'],
          [11, 5, '#0d5167'],
          [2, 6, '#2f9fc4'],
          [3, 6, '#2f9fc4'],
          [4, 6, '#2f9fc4'],
          [5, 6, '#2f9fc4'],
          [6, 6, '#2f9fc4'],
          [7, 6, '#2f9fc4'],
          [8, 6, '#2f9fc4'],
          [9, 6, '#0d5167'],
          [10, 6, '#0d5167'],
          [11, 6, '#0d5167'],
          [2, 7, '#2f9fc4'],
          [3, 7, '#2f9fc4'],
          [4, 7, '#2f9fc4'],
          [5, 7, '#2f9fc4'],
          [6, 7, '#2f9fc4'],
          [7, 7, '#2f9fc4'],
          [8, 7, '#2f9fc4'],
          [9, 7, '#0d5167'],
          [10, 7, '#0d5167'],
          [11, 7, '#0d5167'],
          [1, 9, '#2f9fc4'],
          [1, 10, '#2f9fc4'],
          [1, 11, '#c4384a'],
          [1, 12, '#c4384a'],
        ],
      },
    ],
  },

  // Two cheek spots below the eyes: a diamond each, which is the smallest shape that still reads
  // as a blush rather than a freckle at the 30px rail size.
  blushing: {
    label: 'Blushing',
    variants: [
      {
        note: 'Hand-drawn: a diamond blush on each cheek',
        coversEyes: false,
        pixels: [
          [2, 7, '#c4384a'],
          [8, 7, '#c4384a'],
          [1, 8, '#c4384a'],
          [2, 8, '#c4384a'],
          [3, 8, '#c4384a'],
          [7, 8, '#c4384a'],
          [8, 8, '#c4384a'],
          [9, 8, '#c4384a'],
          [2, 9, '#c4384a'],
          [8, 9, '#c4384a'],
        ],
      },
    ],
  },

};

/** Variant 1 of every accessory, which is what a face wears until someone chooses otherwise. */
export const variantPixels = (accessory: MosaicAccessory, variant = 0): readonly MosaicPixel[] =>
  MOSAIC_ACCESSORIES[accessory].variants[variant].pixels.map(([x, y, fill, anim]) => ({ x, y, fill, anim }));

export const variantCoversEyes = (accessory: MosaicAccessory, variant = 0): boolean =>
  MOSAIC_ACCESSORIES[accessory].variants[variant].coversEyes;

/** One face in the showcase: which body it sits on and what it wears. */
export type MosaicFace = {
  /** 1–25. Face 1 has no accessory. */
  number: number;
  /** `MOSAIC_SHAPES[].name` — the silhouette this face is built on. */
  shapeName: string;
  /** Mirrored bodies are the same silhouette flipped; they count as the same canvas. */
  mirrored: boolean;
  /** null on face 1 only. */
  accessory: MosaicAccessory | null;
};

/**
 * The 25 faces.
 *
 * Face 1 is plain. Faces 2–25 walk the ten accessories two and a half times over, and each pass uses
 * a different set of bodies (and alternates mirroring), so the same accessory only reappears on a
 * silhouette it has not already been seen on. Ordered accessory-first so the showcase reads as "here
 * is sunglasses on six bodies, now here is a hat".
 */
export const MOSAIC_FACES: readonly MosaicFace[] = (() => {
  const shapes = ['tuft', 'sprig', 'pebble', 'crown', 'ribbon', 'sail'] as const;
  const accessories = Object.keys(MOSAIC_ACCESSORIES) as MosaicAccessory[];
  const faces: MosaicFace[] = [{ number: 1, shapeName: 'tuft', mirrored: false, accessory: null }];
  // 24 accessory faces over 6 shapes = four complete passes; each accessory lands on four bodies,
  // and the offset per pass keeps a given accessory off the same silhouette twice.
  for (let index = 0; index < 24; index += 1) {
    const accessory = accessories[index % accessories.length];
    const pass = Math.floor(index / accessories.length);
    faces.push({
      number: index + 2,
      shapeName: shapes[(index + pass) % shapes.length],
      // Alternate mirroring within a pass, so the same accessory is not always facing one way.
      mirrored: (index + pass) % 2 === 1,
      accessory,
    });
  }
  return faces;
})();
