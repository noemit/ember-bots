import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import Blob from './src/blob/Blob';
import LavaBlob from './src/blob/LavaBlob';
import { blobColor } from './src/blob/color';
import { IDENTITY_COLORS, hexToOklch } from './src/blob/contrast';
import {
  LAVA_BUD_SHRINK,
  LAVA_BUD_TRAVEL,
  LAVA_EXTENT,
  LAVA_GOO,
  LAVA_MOTION,
  LAVA_SHAPES,
  LAVA_SLOSH_MAX,
  lavaColors,
  lavaGeometry,
  lavaGrainFrequency,
  lavaRimWidth,
} from './src/blob/lava';
import { seedIdentity, mulberry32 } from './src/blob/seed';
import { BLOB_STYLES, isBlobStyle } from './electron/transport';
import type { BallMood } from './src/types';

const MOODS: BallMood[] = ['idle', 'unread', 'unknown', 'thinking', 'busy', 'input', 'question', 'error'];
const css = readFileSync(new URL('./src/blob/blob-lava.css', import.meta.url), 'utf8');

const markup = (mood: BallMood, seed = 'seed', size = 55) =>
  renderToStaticMarkup(<LavaBlob seed={seed} mood={mood} size={size} />);

const distance = (a: { cx: number; cy: number }, b: { cx: number; cy: number }) =>
  Math.hypot(a.cx - b.cx, a.cy - b.cy);

/**
 * Lava is goo: lobes melted together by a blur-and-threshold filter, with a droplet that comes off
 * while the session works. Pixels are checked by eye; what is pinned here are the rules that keep it
 * drawable — every shape fits its box at any angle, the droplet is attached at rest and clearly free
 * when busy, the pools never touch the rim, and only working moods move.
 */
describe('Lava shapes', () => {
  test('every shape fits the box at any turn, and its bud is the last lobe', () => {
    for (const shape of LAVA_SHAPES) {
      expect(shape.lobes.length).toBeGreaterThanOrEqual(2);
      // Rotation about the centre preserves each lobe's reach, so checking the reach covers every
      // angle the seed can choose.
      for (const lobe of shape.lobes) {
        expect(Math.hypot(lobe.cx, lobe.cy) + lobe.r).toBeLessThanOrEqual(LAVA_EXTENT);
      }
      const bud = shape.lobes[shape.lobes.length - 1];
      expect(bud.r).toBeLessThan(shape.lobes[0].r);
    }
  });

  test('the bud is melted on at rest and hangs free at the peak of a split', () => {
    for (const shape of LAVA_SHAPES) {
      const main = shape.lobes[0];
      const bud = shape.lobes[shape.lobes.length - 1];
      const others = shape.lobes.slice(0, -1);
      // At rest it overlaps something, so the goo joins it with a neck.
      expect(Math.max(...others.map((lobe) => lobe.r + bud.r - distance(lobe, bud)))).toBeGreaterThan(2);

      const length = distance(main, bud);
      const ux = (bud.cx - main.cx) / length;
      const uy = (bud.cy - main.cy) / length;
      const outward = {
        cx: bud.cx + ux * LAVA_BUD_TRAVEL,
        cy: bud.cy + uy * LAVA_BUD_TRAVEL,
      };
      // The CSS bends the throw off that line at the peak (--lava-wx/-wy), so the droplet is checked
      // where it actually goes, not only where the straight throw would take it.
      const drifting = {
        cx: outward.cx + -uy * LAVA_BUD_TRAVEL * 0.45 * 0.7,
        cy: outward.cy + ux * LAVA_BUD_TRAVEL * 0.45 * 0.7,
      };
      const peakR = bud.r * LAVA_BUD_SHRINK;
      for (const peak of [outward, drifting]) {
        // Free means clear of every lobe by more than the goo can bridge (about its blur's width).
        for (const lobe of others) {
          expect(distance(peak, lobe) - lobe.r - peakR).toBeGreaterThan(LAVA_GOO * 1.6);
        }
        // A droplet may hang a little past the box, as Buddy's hop does, but not far.
        expect(Math.hypot(peak.cx, peak.cy) + peakR).toBeLessThanOrEqual(55.5);
      }
    }
  });

  test('the main lobe pools stay inside its rim wherever the swirl carries them', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const geometry = lavaGeometry(mulberry32(seed));
      const [main, ...rest] = geometry.bodies;
      for (const pool of main.pools) {
        // The swirl turns about the main centre, so the reach from that centre is what matters.
        expect(distance(pool, main.lobe) + pool.r).toBeLessThan(main.lobe.r);
      }
      // Every other pool belongs to its lobe and must sit inside it, drift or no drift.
      for (const entry of rest) {
        for (const pool of entry.pools) {
          expect(distance(pool, entry.lobe) + pool.r).toBeLessThan(entry.lobe.r);
        }
      }
    }
  });

  test('a working lobe drifts, but never out of the box', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const geometry = lavaGeometry(mulberry32(seed));
      const bodies = geometry.bodies;
      // The anchor and the bud never slosh: one holds the shape, the other has its own throw.
      expect(bodies[0].slosh).toBeUndefined();
      expect(bodies[bodies.length - 1].slosh).toBeUndefined();
      for (const entry of bodies.slice(1, -1)) {
        const slosh = entry.slosh!;
        expect(slosh).toBeDefined();
        const magnitude = Math.hypot(slosh.dx, slosh.dy);
        // Enough to see at rail size, not enough to redraw the blob as something else.
        expect(magnitude).toBeGreaterThan(1.5);
        expect(magnitude).toBeLessThanOrEqual(LAVA_SLOSH_MAX);
        const rested = Math.hypot(entry.lobe.cx - 50, entry.lobe.cy - 50) + entry.lobe.r;
        const drifted =
          Math.hypot(entry.lobe.cx + slosh.dx - 50, entry.lobe.cy + slosh.dy - 50) + entry.lobe.r;
        // A lobe that swells outward may reach past the rest pose's bound, but only into the
        // margin the filter region allows; a lobe that pulls in is strictly inside.
        expect(Math.max(drifted, rested)).toBeLessThan(LAVA_EXTENT + 3);
        expect(drifted).toBeLessThanOrEqual(52);
      }
    }
  });

  test('a working body moves on more than one clock', () => {
    const lump = LAVA_SHAPES.find((shape) => shape.name === 'lump');
    const geometry = lavaGeometry(mulberry32(7), lump);
    expect(geometry.bodies.length).toBe(3);

    const html = renderToStaticMarkup(<LavaBlob seed="x" mood="busy" />);
    // The middle lobe drifts on its own period, set from its position in the stack...
    const periods = [...new Set([...html.matchAll(/--slosh-dur:\s*([\d.]+)s/g)].map((m) => m[1]))];
    expect(periods).toHaveLength(1);
    // ...while the rise, the swelling body, the pool and the glow each run on theirs. Busy is the sum
    // of four animations on four clocks, which is what makes it read as churn rather than a loop.
    const busyDurations = [...css.matchAll(/data-motion='split'\][^{]*\{[^}]*animation: [\w-]+ ([\d.]+)s/g)]
      .map((match) => match[1]);
    expect(busyDurations.length).toBeGreaterThanOrEqual(4);
    expect(new Set(busyDurations).size).toBe(busyDurations.length);
    for (const part of ['blob-lava-rise', 'blob-lava-core', 'blob-lava-bud', 'blob-lava-pools', 'blob-lava-glow']) {
      expect(css).toContain(`data-motion='split'] .${part} {`);
    }
    // The body does not merely breathe: it squashes, so its two axes move in opposite directions.
    const coreStart = css.indexOf('@keyframes lava-core');
    const core = css.slice(coreStart, css.indexOf('@keyframes', coreStart + 1));
    const scales = [...core.matchAll(/scale\(([\d.]+), ([\d.]+)\)/g)];
    expect(scales.length).toBeGreaterThanOrEqual(2);
    const widened = scales.some(([, x, y]) => Number(x) > Number(y) + 0.02);
    const narrowed = scales.some(([, x, y]) => Number(y) > Number(x) + 0.02);
    expect(widened && narrowed).toBe(true);
    // A middle lobe that pulls in while the body swells: two directions at once.
    const { lobe, slosh } = geometry.bodies[1];
    expect(slosh).toBeDefined();
    expect(Math.hypot(slosh!.dx, slosh!.dy)).toBeGreaterThan(1.5);
    expect(lobe.r).toBeGreaterThan(0);
  });

  test('a two-lobe shape still moves: the body swells even with nothing to drift', () => {
    // drop and cell have no middle lobe, so the core's breathing is all the silhouette movement
    // they get — without it those sessions would look frozen while working.
    for (const name of ['drop', 'cell']) {
      const shape = LAVA_SHAPES.find((entry) => entry.name === name)!;
      const geometry = lavaGeometry(mulberry32(3), shape);
      expect(geometry.bodies).toHaveLength(2);
      expect(geometry.bodies.slice(1, -1)).toHaveLength(0);
      const html = renderToStaticMarkup(
        <LavaBlob seed="same" mood="busy" identity={{ ...seedIdentity('same'), shapeName: name }} />
      );
      expect(html).toContain('blob-lava-core');
      expect(html).toContain('data-motion="split"');
    }
  });
});

describe('Lava colour', () => {
  test('the body is the shared identity colour, and blobColor agrees with the renderer', () => {
    for (const seed of ['pi:tower', 'a', 'session::42', 'local::abc']) {
      const html = markup('idle', seed);
      const body = /<circle[^>]*fill="(var\(--blob-\d+\))"/.exec(html)?.[1];
      expect(body).toBe(blobColor('lava', seedIdentity(seed)));
    }
    // An explicit colour index is the colour you picked, with no private palette in between.
    const picked = renderToStaticMarkup(
      <LavaBlob seed="x" identity={{ ...seedIdentity('x'), colorIndex: 7 }} mood="idle" />
    );
    expect(picked).toContain('fill="var(--blob-7)"');
  });

  test('every palette entry gets a contrasting core, a stepping-stone halo and a dark-theme rim', () => {
    const hueGap = (a: number, b: number) => {
      const d = Math.abs(a - b) % 360;
      return Math.min(d, 360 - d);
    };
    for (let index = 0; index < IDENTITY_COLORS.length; index += 1) {
      const colors = lavaColors(index);
      for (const value of Object.values(colors)) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
      const [, , bodyHue] = hexToOklch(IDENTITY_COLORS[index]);
      const [, , coreHue] = hexToOklch(colors.core);
      const [, , haloHue] = hexToOklch(colors.halo);
      // The core contrasts; the halo sits between, so the blend does not pass through grey.
      expect(hueGap(bodyHue, coreHue)).toBeGreaterThan(60);
      expect(hueGap(bodyHue, haloHue)).toBeLessThan(hueGap(bodyHue, coreHue));
      // Deep enough to read as a rim against a dark surface, and still a colour.
      const [deepLightness, deepChroma] = hexToOklch(colors.deep);
      expect(deepLightness).toBeLessThan(0.5);
      expect(deepChroma).toBeGreaterThan(0.04);
    }
  });

  test('the same seed always draws the same lamp', () => {
    expect(markup('busy', 'pi:tower')).toBe(markup('busy', 'pi:tower'));
  });
});

describe('Lava moods', () => {
  test('resting and broken states never move; working ones do', () => {
    for (const mood of ['idle', 'unread', 'unknown', 'error'] as const) expect(LAVA_MOTION[mood]).toBe('still');
    expect(LAVA_MOTION.busy).toBe('split');
    expect(LAVA_MOTION.thinking).toBe('swirl');
    expect(LAVA_MOTION.input).toBe('wait');
    expect(LAVA_MOTION.question).toBe('wait');
    for (const mood of MOODS) expect(markup(mood)).toContain(`data-motion="${LAVA_MOTION[mood]}"`);
  });

  test('every working mood also says so in a still frame', () => {
    // Busy: the droplet's resting place is away from the body, so a frozen frame shows it free.
    expect(css).toMatch(
      /\[data-motion='split'\] \.blob-lava-bud \{[^}]*transform: translate\(var\(--lava-dx[^}]*scale\(/
    );
    // Thinking draws the shared arc; the asks and the failure draw the shared badges.
    expect(markup('thinking')).toContain('blob-arc');
    for (const mood of ['input', 'question', 'error'] as const) expect(markup(mood)).toContain('blob-badge');
    expect(markup('idle')).not.toContain('blob-badge');
    // Error drains the colour inside the filter, so a standalone copy (the dock icon) shows it too.
    expect(markup('error')).toContain('type="saturate"');
    expect(markup('idle')).not.toContain('type="saturate"');
  });

  test('reduced motion stops the goo but keeps the pose', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.blob-lava .blob-lava-bud');
    expect(reduced).toContain('.blob-lava .blob-lava-pools');
    expect(reduced).toContain('animation: none');
    // Only the animation is removed; the split rule's transform stays in force.
    expect(reduced).not.toContain('transform: none');
  });

  test('staggering reaches the nested groups', () => {
    // `animation-delay: inherit` would read the immediate parent <g>, which has none: every lamp in
    // the rail would split in unison.
    expect(css).not.toContain('animation-delay: inherit');
    expect(markup('busy')).toMatch(/--lava-delay:-?\d/);
  });
});

describe('Lava drawing', () => {
  test('two blobs on one page never share a filter', () => {
    const html = renderToStaticMarkup(
      <>
        <LavaBlob seed="a" mood="idle" />
        <LavaBlob seed="b" mood="idle" />
      </>
    );
    const ids = [...html.matchAll(/<(?:filter|radialGradient) id="([^"]+)"/g)].map((match) => match[1]);
    // One goo filter and three pool gradients each, all distinct: a shared id on one page would make
    // the second blob inherit the first one's colours.
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });

  test('the ink falls back to near-black where no theme CSS reaches (the dock icon)', () => {
    expect(markup('idle')).toMatch(/flood-color:var\(--lava-ink, ?#16130f\)/);
    // A dark theme swaps it for the blob's own deep hue, set per blob.
    expect(css).toMatch(/\.dark \.blob-lava \{[^}]*--lava-ink: var\(--lava-deep/);
    expect(markup('idle')).toMatch(/--lava-deep:#[0-9a-f]{6}/i);
  });

  test('grain and rim hold their on-screen size across avatar sizes', () => {
    for (const size of [22, 30, 55, 96, 358]) {
      // Grain frequency per viewBox unit grows with size, so a grain stays near a CSS pixel.
      expect(lavaGrainFrequency(size)).toBeGreaterThan(0);
      expect(lavaGrainFrequency(size * 2)).toBeGreaterThanOrEqual(lavaGrainFrequency(size));
      // The rim never thins to a hairline nor swallows a small blob.
      expect(lavaRimWidth(size)).toBeGreaterThanOrEqual(1.5);
      expect(lavaRimWidth(size)).toBeLessThanOrEqual(3.2);
    }
    // Body grain is left out at rail sizes, where a speck is a pixel of dirt.
    expect(markup('idle', 'seed', 55)).not.toContain('darkSpecks');
    expect(markup('idle', 'seed', 120)).toContain('darkSpecks');
  });

  test('the Blob switch draws Lava, and settings accept it', () => {
    expect(renderToStaticMarkup(<Blob style="lava" seed="seed" mood="idle" />)).toContain('blob-lava');
    expect(BLOB_STYLES).toContain('lava');
    expect(isBlobStyle('lava')).toBe(true);
  });
});
