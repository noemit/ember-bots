import { hashString, mulberry32 } from './seed';

/**
 * Crystal — the counterpart to Buddy's creatures: a cut stone of the session's colour, flat facets
 * for volume and a halo that lights up when the session is working. The halo *is* the mood: dark
 * when idle, roaring when busy, amber when it wants you, cold grey when the turn failed.
 *
 * Geometry lives in the same 100x100 grid as Buddy and comes from the identity's shape and motion
 * seeds, so a session always draws the same lump. Nothing here is stateful or measured: the
 * component renders it, blob.css animates the heat.
 */
export type CrystalGeometry = {
  /** Closed path for the lump itself. */
  body: string;
  /** Shared 3D corners: the outline first, then the three raised interior junctions. */
  vertices: Array<[number, number, number]>;
  rimCount: number;
  /**
   * The cut planes, as white/black overlays: volume without any colour maths, so it works on every
   * palette entry and both themes. `lit` catches the light, `shade` turns away, `soft` is the
   * in-between plane that stops a two-tone split reading as a flat sticker.
   */
  facets: Array<{
    vertices: [number, number, number];
    d: string;
    kind: 'lit' | 'shade' | 'soft';
    opacity: number;
    /** Maps a 100-unit reflection plane along the rim and inward toward this facet's anchor. */
    reflectionTransform: string;
  }>;
  tilt: number;
  /** Negative, per-blob animation delay so a rail of crystals never glows in unison. */
  heatDelay: number;
};

const TAU = Math.PI * 2;

/**
 * Named archetypes, so the appearance picker can offer real choices and `shapeName` stays
 * meaningful in the settings schema (Buddy works the same way). Each one is a family — the seed
 * still varies the lump inside it, so two sessions sharing an archetype never look identical.
 */
export type CrystalShape = {
  name: string;
  /** Facets around the rim: fewer reads as chunkier, more as a worn pebble. */
  sides: number;
  /** 0 = a fair circle, 1 = deeply notched. */
  wobble: number;
  /** How far each corner is knocked off: 0 sharp, 1 soft. */
  roundness: number;
  /** Body radius in the 100x100 grid, so archetypes can differ in bulk as well as outline. */
  radius: number;
};

export const CRYSTAL_SHAPES: CrystalShape[] = [
  { name: 'quartz', sides: 9, wobble: 0.45, roundness: 0.35, radius: 37 },
  { name: 'prism', sides: 12, wobble: 0.2, roundness: 0.6, radius: 39 },
  { name: 'flint', sides: 10, wobble: 0.85, roundness: 0.15, radius: 36 },
  { name: 'geode', sides: 11, wobble: 0.12, roundness: 0.85, radius: 34 },
  { name: 'shard', sides: 8, wobble: 1, roundness: 0.05, radius: 37 },
  { name: 'cluster', sides: 13, wobble: 0.6, roundness: 0.3, radius: 36 },
];

/** Rounded polygon: straight facets with their corners knocked off, which reads as chipped crystal. */
const facetPath = (points: Array<[number, number]>, round: number): string => {
  const count = points.length;
  const parts: string[] = [];
  for (let index = 0; index < count; index++) {
    const previous = points[(index - 1 + count) % count];
    const point = points[index];
    const next = points[(index + 1) % count];
    const inX = point[0] + (previous[0] - point[0]) * round;
    const inY = point[1] + (previous[1] - point[1]) * round;
    const outX = point[0] + (next[0] - point[0]) * round;
    const outY = point[1] + (next[1] - point[1]) * round;
    parts.push(
      `${index === 0 ? 'M' : 'L'}${inX.toFixed(2)} ${inY.toFixed(2)}`,
      `Q${point[0].toFixed(2)} ${point[1].toFixed(2)} ${outX.toFixed(2)} ${outY.toFixed(2)}`
    );
  }
  return `${parts.join(' ')} Z`;
};

export const crystalGeometry = (
  shapeRng: () => number,
  motionRng: () => number,
  shape?: CrystalShape
): CrystalGeometry => {
  const archetype =
    shape ?? CRYSTAL_SHAPES[Math.floor(shapeRng() * CRYSTAL_SHAPES.length) % CRYSTAL_SHAPES.length];
  const sides = archetype.sides;
  // Two low harmonics give the lump its asymmetry; low frequencies keep it convex enough to read
  // as a solid at 30px, where higher harmonics just look like noise.
  const spread = 0.05 + archetype.wobble * 0.09;
  const wobble2 = spread * (0.7 + shapeRng() * 0.6);
  const wobble3 = spread * (0.5 + shapeRng() * 0.6);
  const phase2 = shapeRng() * TAU;
  const phase3 = shapeRng() * TAU;
  const round = 0.06 + archetype.roundness * 0.3;
  const RADIUS = archetype.radius * (1 + (shapeRng() - 0.5) * 0.05);

  const points = Array.from({ length: sides }, (_, index) => {
    const angle = (index / sides) * TAU - Math.PI / 2;
    const radius =
      RADIUS * (1 + wobble2 * Math.sin(2 * angle + phase2) + wobble3 * Math.sin(3 * angle + phase3));
    return [50 + Math.cos(angle) * radius, 50 + Math.sin(angle) * radius]
      .map(value => Number(value.toFixed(2))) as [number, number];
  });

  const body = facetPath(points, round);

  // A raised triangle joins the rim through a complete mesh. Neighbouring faces reuse the exact
  // same corners, so there are no overlapping planes, crossing cuts or unassigned patches.
  const junctionRim = [0, Math.floor(sides / 3), Math.floor(sides * 2 / 3)];
  const vertices: CrystalGeometry['vertices'] = points.map(([x, y]) => [x, y, 0]);
  for (const index of junctionRim) {
    const inset = .35 + shapeRng() * .12;
    vertices.push([
      Number((50 + (points[index][0] - 50) * inset).toFixed(2)),
      Number((50 + (points[index][1] - 50) * inset).toFixed(2)),
      Number((14 + shapeRng() * 6).toFixed(2)),
    ]);
  }
  const junctionFor = (index: number) => {
    const distance = (rim: number) => Math.min(Math.abs(index - rim), sides - Math.abs(index - rim));
    return sides + junctionRim.reduce((best, rim, candidate) =>
      distance(rim) < distance(junctionRim[best]) ? candidate : best, 0);
  };
  const triangles: Array<[number, number, number]> = [];
  for (let index = 0; index < sides; index++) {
    const next = (index + 1) % sides;
    const inner = junctionFor(index);
    const nextInner = junctionFor(next);
    triangles.push([index, next, nextInner]);
    if (inner !== nextInner) triangles.push([index, nextInner, inner]);
  }
  triangles.push([sides, sides + 1, sides + 2]);

  const facets = triangles.map((corners): CrystalGeometry['facets'][number] => {
    const [before, after, anchor] = corners.map(index => vertices[index]);
    const u = after.map((value, axis) => value - before[axis]);
    const v = anchor.map((value, axis) => value - before[axis]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    // One upper-left light for the whole stone, calculated from each actual triangular plane.
    const light = (-.45 * normal[0] - .65 * normal[1] + .6 * normal[2]) / Math.hypot(...normal);
    const shade = light < .48;
    return {
      vertices: corners,
      d: `M${before[0].toFixed(2)} ${before[1].toFixed(2)} ` +
        `L${after[0].toFixed(2)} ${after[1].toFixed(2)} ` +
        `L${anchor[0].toFixed(2)} ${anchor[1].toFixed(2)} Z`,
      kind: shade ? 'shade' : light > .72 ? 'lit' : 'soft',
      opacity: Number(Math.min(.3, shade ? (.48 - light) * .45 : .035 + (light - .48) * .4).toFixed(3)),
      // The same local light bends and narrows differently on every cut. Derive the basis from
      // the actual face so reflections follow all six archetypes and their seeded variations.
      reflectionTransform: `matrix(${[
        (after[0] - before[0]) / 100,
        (after[1] - before[1]) / 100,
        (anchor[0] - (before[0] + after[0]) / 2) / 100,
        (anchor[1] - (before[1] + after[1]) / 2) / 100,
        before[0], before[1],
      ].join(' ')})`,
    };
  });

  return {
    body,
    vertices,
    rimCount: sides,
    facets,
    tilt: Math.round((motionRng() - 0.5) * 20),
    heatDelay: -Number((motionRng() * 5).toFixed(2)),
  };
};

/** Convenience for callers that only have the seeds (tests, tooling). */
export const crystalForSeeds = (shapeSeed: string, motionSeed: string): CrystalGeometry =>
  crystalGeometry(mulberry32(hashString(shapeSeed)), mulberry32(hashString(motionSeed)));
