import type { BallMood } from '../types';
import { IDENTITY_COLORS, hexToOklch, oklchToHexColor } from './contrast';

/**
 * Lava — goo from a lava lamp, drawn the way a risograph print would draw it: two or three round
 * lobes melted together through soft necks, pools of a contrasting colour drifting inside, and a dark
 * ink rim that stipples inward with grain.
 *
 * The silhouette is never stored as a path. The lobes are plain circles run through a "goo" filter
 * (blur, then a hard alpha threshold), which is what melts them together — and what lets a lobe pull
 * away and rejoin while the session works without any path morphing. Everything here is the pure
 * half: which lobes, where the pools sit, which colours, how the mood moves them. `LavaBlob.tsx`
 * draws it and `blob-lava.css` animates it.
 */

/** One round lobe, in a frame centred on the origin (the component adds the 50,50 offset). */
export type LavaLobe = { cx: number; cy: number; r: number };

/**
 * A named arrangement of lobes, so the appearance picker can offer real choices and `shapeName`
 * stays meaningful. The **last lobe is the bud**: the small one that pinches off and rejoins while
 * the session is busy. The seed still rotates and mirrors the arrangement, so two sessions sharing
 * a shape rarely look the same.
 */
export type LavaShape = { name: string; lobes: LavaLobe[] };

export const LAVA_SHAPES: LavaShape[] = [
  // One plump lobe with a droplet clinging to its shoulder.
  {
    name: 'drop',
    lobes: [
      { cx: -5, cy: 5, r: 34 },
      { cx: 24.3, cy: -24.3, r: 13 },
    ],
  },
  // Two near-equal lobes with a waist, and a bead hanging off one end.
  {
    name: 'peanut',
    lobes: [
      { cx: -15, cy: 6, r: 26 },
      { cx: 16, cy: -6, r: 23 },
      { cx: 26, cy: 24, r: 12 },
    ],
  },
  // Three lobes in a loose triangle.
  {
    name: 'trio',
    lobes: [
      { cx: -9, cy: 9, r: 29 },
      { cx: 19, cy: -16, r: 18 },
      { cx: 24, cy: 25, r: 12 },
    ],
  },
  // A body that tapers into a tail, like a lamp's blob stretching upward.
  {
    name: 'tail',
    lobes: [
      { cx: -12, cy: 12, r: 26 },
      { cx: 10, cy: -6, r: 17 },
      { cx: 24.1, cy: -24.8, r: 10.5 },
    ],
  },
  // A knobbly body: a large lobe with a bulge melted into its rim, and a droplet beside it.
  {
    name: 'lump',
    lobes: [
      { cx: -2, cy: 0, r: 29 },
      { cx: -20, cy: -19, r: 15 },
      { cx: 26.3, cy: 23.5, r: 12 },
    ],
  },
  // A fat round cell with a small one budding underneath.
  {
    name: 'cell',
    lobes: [
      { cx: 4, cy: -6, r: 33 },
      { cx: -22.6, cy: 26, r: 13 },
    ],
  },
];

/** The extent every lobe must stay inside, measured from the centre (the 100-unit box is ±50). */
export const LAVA_EXTENT = 47.5;

/**
 * How far the bud travels outward when it pinches off, in viewBox units, and how small it is when it
 * gets there. Both are needed to clear the neck: the goo bridges any gap narrower than about twice its
 * blur, so travel alone would have to carry a droplet well outside the box before it let go.
 */
export const LAVA_BUD_TRAVEL = 10;
export const LAVA_BUD_SHRINK = 0.8;

/**
 * Ink for the rim and its stipple. The theme palette is already lightened until this near-black
 * clears 3:1 against every entry (`identityPaletteFor`), so the rim always reads on the body.
 */
export { FACE_INK as LAVA_INK } from './contrast';

/** Blur that melts the lobes together, in viewBox units. Larger melts more, but shrinks small lobes. */
export const LAVA_GOO = 3.6;

const rotate = (x: number, y: number, degrees: number): [number, number] => {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [x * cos - y * sin, x * sin + y * cos];
};

/**
 * `halo` and `core` make one two-tone pool: a saturated ring around a lighter centre, the way the
 * reference puts red around yellow inside a pink lobe. Blending straight from the body to a
 * contrasting hue goes through grey; the halo is the stepping stone that keeps it clean. `glow` is
 * a single soft lighter patch.
 */
export type LavaTone = 'halo' | 'core' | 'glow';

/** A pool is part of its lobe, so it travels with it and can never be left floating in open goo. */
export type LavaPool = LavaLobe & { tone: LavaTone };

/** How far a lobe drifts while the session works, in viewBox units. */
export type LavaSlosh = { dx: number; dy: number };

export type LavaBody = {
  lobe: LavaLobe;
  /** Pools painted inside this lobe, in draw order. */
  pools: LavaPool[];
  /**
   * How far this lobe drifts while the session is working, toward and away from the main lobe, so
   * the necks thicken and thin. Absent on the main lobe, which anchors the shape.
   */
  slosh?: LavaSlosh;
};

export type LavaGeometry = {
  shape: string;
  /** Every lobe with its pools, in draw order: the first anchors the shape, the last is the bud. */
  bodies: LavaBody[];
  /** Direction the bud pinches off in, already scaled by {@link LAVA_BUD_TRAVEL}. */
  budTravel: { dx: number; dy: number };
  /** Sideways drift at the peak, so a thrown droplet does not travel on a rail. */
  budDrift: { dx: number; dy: number };
  /** Centre of the main lobe; the main lobe's pools swirl about it. */
  swirlCentre: { x: number; y: number };
};

/**
 * How far a middle lobe drifts while working, in viewBox units. A lava lamp's body is never still:
 * lobes pull together and apart, which is what makes the necks breathe. Small next to the bud's
 * {@link LAVA_BUD_TRAVEL} because the silhouette must stay recognisably the same blob.
 */
export const LAVA_SLOSH = 3.8;
/** The most any lobe may drift, which is what keeps a working blob inside its box (see the tests). */
export const LAVA_SLOSH_MAX = 4.2;
/** How long one drift takes, and how much longer each further lobe takes, so they never sync. */
export const LAVA_SLOSH_PERIOD = 3;
export const LAVA_SLOSH_STAGGER = 0.7;

/**
 * Places a shape for one identity: rotated by the seed, mirrored on a coin flip, and given its pools.
 * Rotation alone keeps every lobe inside {@link LAVA_EXTENT} because the shapes are drawn to fit at
 * any angle — `lava.test.ts` checks every shape at every angle, with its bud pulled away.
 */
export const lavaGeometry = (rng: () => number, named?: LavaShape): LavaGeometry => {
  const pick = Math.floor(rng() * LAVA_SHAPES.length);
  // Drawn even when the shape is named, so naming one keeps the seed's own turn and pools.
  const shape = named ?? LAVA_SHAPES[pick];
  const angle = rng() * 360;
  const mirror = rng() < 0.5 ? -1 : 1;
  const place = ({ cx, cy, r }: LavaLobe): LavaLobe => {
    const [x, y] = rotate(cx * mirror, cy, angle);
    return { cx: 50 + x, cy: 50 + y, r };
  };
  const lobes = shape.lobes.map(place);
  const main = lobes[0];
  const bud = lobes[lobes.length - 1];
  const length = Math.hypot(bud.cx - main.cx, bud.cy - main.cy) || 1;
  const ux = (bud.cx - main.cx) / length;
  const uy = (bud.cy - main.cy) / length;
  const offset = (lobe: LavaLobe, distance: number, degrees: number) => {
    const [x, y] = rotate(lobe.r * distance, 0, degrees);
    return { cx: lobe.cx + x, cy: lobe.cy + y };
  };

  // The main lobe: a two-tone pool set off-centre, its core nudged further out than the halo so the
  // ring is lopsided like a real blot, and a soft glow. Every pool stays well inside the rim: a pool
  // is part of the goo, and one that touched the rim would grow the outline.
  const turn = rng() * 360;
  const mainPools: LavaPool[] = [
    { ...offset(main, 0.26, turn), r: main.r * 0.56, tone: 'halo' },
    { ...offset(main, 0.34, turn + 12), r: main.r * 0.32, tone: 'core' },
    { ...offset(main, 0.42, turn + 160 + rng() * 40), r: main.r * 0.26, tone: 'glow' },
  ];

  const bodies: LavaBody[] = lobes.map((lobe, index) => {
    if (index === 0) return { lobe, pools: mainPools };
    if (index === lobes.length - 1) {
      // A droplet carries a small core of the contrasting colour, like the reference's little beads.
      return { lobe, pools: [{ cx: lobe.cx, cy: lobe.cy, r: lobe.r * 0.42, tone: 'core' as const }] };
    }
    // Alternate pulling in and swelling out, so one neck thins while another thickens.
    const ratio = 0.55 + 0.45 * (lobe.r / main.r);
    const amplitude = Math.min(LAVA_SLOSH_MAX, Math.max(2.2, LAVA_SLOSH * ratio)) * (index % 2 === 0 ? -1 : 1);
    return {
      lobe,
      pools: [
        {
          ...offset(lobe, 0.2, rng() * 360),
          r: lobe.r * 0.5,
          tone: (rng() < 0.5 ? 'glow' : 'halo') as LavaTone,
        },
      ],
      slosh: {
        dx: ((lobe.cx - main.cx) / (Math.hypot(lobe.cx - main.cx, lobe.cy - main.cy) || 1)) * amplitude,
        dy: ((lobe.cy - main.cy) / (Math.hypot(lobe.cx - main.cx, lobe.cy - main.cy) || 1)) * amplitude,
      },
    };
  });

  return {
    shape: shape.name,
    bodies,
    budTravel: { dx: ux * LAVA_BUD_TRAVEL, dy: uy * LAVA_BUD_TRAVEL },
    // A quarter-turn off the throw, at under half its length: the droplet arcs instead of sliding.
    budDrift: { dx: -uy * LAVA_BUD_TRAVEL * 0.45, dy: ux * LAVA_BUD_TRAVEL * 0.45 },
    swirlCentre: { x: main.cx, y: main.cy },
  };
};

export type LavaColors = Record<LavaTone, string> & {
  /**
   * The rim on a dark theme: a deep shade of the body's own hue. Near-black ink disappears into a
   * dark surface, which leaves the stipple as the visible edge and makes the goo look moth-eaten.
   */
  deep: string;
};

/**
 * Accent colours for an identity colour, from the *base* palette entry rather than the theme's
 * adjusted one: they live inside the body, so they never sit against the surface and need no
 * contrast correction. Deriving them from the index (not the seed) keeps a project's sessions in
 * one colour story.
 *
 * The core turns ~110° away from the body — the pink-to-yellow, orange-to-teal relationship most of
 * the reference's pairs share — and which way it turns alternates along the palette, so neighbouring
 * colours don't all get the same partner. The halo sits halfway along that turn, deeper and more
 * saturated, so the body reaches the core through a colour instead of through grey.
 */
export const lavaColors = (colorIndex: number, customColor?: string): LavaColors => {
  const count = IDENTITY_COLORS.length;
  const index = ((colorIndex % count) + count) % count;
  const [lightness, chroma, hue] = hexToOklch(customColor ?? IDENTITY_COLORS[index]);
  const turn = index % 2 === 0 ? 110 : -110;
  return {
    core: oklchToHexColor(0.84, Math.max(chroma, 0.15), hue + turn),
    halo: oklchToHexColor(0.6, Math.max(chroma, 0.19), hue + turn * 0.45),
    glow: oklchToHexColor(Math.min(0.93, Math.max(lightness, 0.6) + 0.15), Math.max(chroma, 0.1), hue - 20),
    deep: oklchToHexColor(0.4, Math.max(chroma, 0.1), hue),
  };
};

/**
 * How each mood moves the goo. Idle, unread and error never move: motion is how the rail says a
 * session is *doing* something.
 *
 * - `swirl` — the pools drift around inside a still silhouette (thinking: busy inside, nothing out).
 * - `split` — the bud pinches off and rejoins while the pools churn (busy: the lamp is on).
 * - `wait`  — the bud stays put and the pools barely drift (input, question: waiting, not working).
 */
export type LavaMotion = 'still' | 'swirl' | 'split' | 'wait';

export const LAVA_MOTION: Record<BallMood, LavaMotion> = {
  idle: 'still',
  unread: 'still',
  unknown: 'still',
  error: 'still',
  thinking: 'swirl',
  busy: 'split',
  input: 'wait',
  question: 'wait',
};

/**
 * Grain frequency for a rendered size. The noise is defined in viewBox units, so a fixed frequency
 * would be sub-pixel fizz in the rail and coarse blotches on the dock icon; this keeps one grain
 * close to one CSS pixel at every size, which is the scale the reference's print grain sits at.
 */
export const lavaGrainFrequency = (size: number): number =>
  Math.round(Math.min(4, Math.max(0.15, (size / 100) * 0.7)) * 1000) / 1000;

/**
 * Width of the solid ink band, in viewBox units, for a rendered size. A fixed width is a hairline at
 * rail sizes (1.5 units is under a pixel at 55px) and a slab on the dock icon; the reference's rim is
 * a confident line at every scale, so hold it near 1.4 CSS pixels, within limits that keep a tiny
 * blob from being all rim.
 */
export const lavaRimWidth = (size: number): number =>
  Math.round(Math.min(3.2, Math.max(1.5, 140 / Math.max(size, 1))) * 100) / 100;
