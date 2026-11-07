import * as React from 'react';
import { hashString, mulberry32, seedIdentity } from './seed';
import { IDENTITY_COLORS } from './contrast';
import {
  LAVA_GOO,
  LAVA_MOTION,
  LAVA_SHAPES,
  lavaColors,
  lavaGeometry,
  lavaGrainFrequency,
  lavaRimWidth,
  lavaTiming,
  lavaWorkingMotion,
  type LavaBody,
} from './lava';
import { MoodBadge } from './overlays';
import type { AvatarIdentity, BallMood, BallState } from '../types';
import './blob.css';
import './blob-lava.css';

type Props = {
  seed: string;
  identity?: AvatarIdentity;
  size?: number;
  state?: BallState;
  mood?: BallMood;
  interactive?: boolean;
};

/**
 * The rendered size below which body grain is left out. At rail sizes (22-55px) a speck is a whole
 * pixel of a small avatar and reads as dirt, not print; the rim's stipple carries the texture there.
 */
const BODY_GRAIN_MIN_SIZE = 64;

/** The dark-theme rim of an errored blob: neutral, like the drained body it surrounds. */
const COLD_DEEP = '#3b3a39';

const TONES = ['halo', 'core', 'glow'] as const;

/**
 * Lava — melted lobes of the session's colour with contrasting pools inside and a stippled ink rim.
 * See `lava.ts` for the rules. Mood is motion first: still when idle, gathering and melting while thinking,
 * and while busy the whole body works — it rises and settles, swells and squashes, any middle lobe
 * pulls in and out, a droplet is thrown off and reabsorbed, and the glow turns against the pool. Each
 * working mood also sets something *static* (the droplet's resting place is already detached, the
 * interior pools and decision badges), so the state still reads in a still frame, on the dock icon and
 * under `prefers-reduced-motion`.
 */
export default function LavaBlob({
  seed,
  identity,
  size = 30,
  mood = 'idle',
  state = 'idle',
  // Accepted for signature parity; Lava has no eyes to follow the cursor with.
  interactive: _interactive = true,
}: Props) {
  // Filter ids must be unique per instance; useId contains colons, which are illegal in url().
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');

  const { geometry, body, colors, noiseSeed, timing, working } = React.useMemo(() => {
    const resolved = identity ?? seedIdentity(seed);
    const colorRng = mulberry32(hashString(`lava:${resolved.colorSeed}`));
    const shapeRng = mulberry32(hashString(`lava:${resolved.shapeSeed}`));
    const motionRng = mulberry32(hashString(`lava:${resolved.motionSeed}`));
    // Consumed in the same order as blobColor(), so the rail's activity dot matches the goo.
    const index =
      Math.abs(resolved.colorIndex ?? Math.floor(colorRng() * IDENTITY_COLORS.length)) %
      IDENTITY_COLORS.length;
    return {
      geometry: lavaGeometry(
        shapeRng,
        LAVA_SHAPES.find((shape) => shape.name === resolved.shapeName)
      ),
      body: resolved.color ?? `var(--blob-${index})`,
      colors: lavaColors(index, resolved.color),
      noiseSeed: Math.floor(motionRng() * 997),
      timing: lavaTiming(motionRng),
      working: lavaWorkingMotion(motionRng),
    };
  }, [identity, seed]);

  const motion = LAVA_MOTION[mood] ?? 'still';
  const cold = mood === 'error';
  const grain = lavaGrainFrequency(size);
  const rim = lavaRimWidth(size);
  const bodyGrain = size >= BODY_GRAIN_MIN_SIZE;
  const budIndex = geometry.bodies.length - 1;
  const [mainBody, ...restBodies] = geometry.bodies;
  const bud = restBodies[restBodies.length - 1];
  const middles = restBodies.slice(0, -1);
  const swirl = mainBody.lobe;
  // The main lobe's glow turns against its pool: colour churns inside the body while the body itself
  // churns, which is what a lava lamp does and what a single rotating disc never looked like.
  const mainPools = mainBody.pools.filter((pool) => pool.tone !== 'glow');
  const mainGlow = mainBody.pools.filter((pool) => pool.tone === 'glow');

  const at = (point: { cx: number; cy: number }) =>
    `${point.cx.toFixed(2)}px ${point.cy.toFixed(2)}px`;

  /**
   * Per-lobe chrome: the anchor every transform rotates or scales about, and for a middle lobe its
   * drift. The drift rides custom properties rather than the element's own `transform`, so the CSS
   * is the only thing that decides when it happens.
   */
  const lobeStyle = (entry: LavaBody, index: number): React.CSSProperties => {
    const clocks = mood === 'busy' ? working : timing;
    const clock = index === budIndex ? clocks.bud : clocks.slosh;
    const style: Record<string, string> = {
      transformOrigin: at(entry.lobe),
      '--lobe-duration': `${clock.duration}s`,
      '--lobe-delay': `${clock.delay}s`,
      '--flow-x': `${geometry.budDrift.dx.toFixed(2)}px`,
      '--flow-y': `${geometry.budDrift.dy.toFixed(2)}px`,
    };
    if (index > 0 && index < budIndex && entry.slosh) {
      style['--slosh-dx'] = `${entry.slosh.dx.toFixed(2)}px`;
      style['--slosh-dy'] = `${entry.slosh.dy.toFixed(2)}px`;
      style['--flow-x'] = `${(-entry.slosh.dy * .4).toFixed(2)}px`;
      style['--flow-y'] = `${(entry.slosh.dx * .4).toFixed(2)}px`;
    }
    return style as React.CSSProperties;
  };

  const pools = (list: LavaBody['pools']) =>
    list.map((pool, index) => (
      <circle key={index} cx={pool.cx} cy={pool.cy} r={pool.r} fill={`url(#${uid}-${pool.tone})`} />
    ));

  return (
    <div
      className="blob blob-lava"
      data-mood={mood}
      data-state={state}
      data-motion={motion}
      data-shape={geometry.shape}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        // CSS owns the timelines, including pause and reduced motion. The body and its pools read
        // the same clocks; the other parts start at independent phases instead of sharing a beat.
        ...Object.fromEntries(Object.entries(timing).flatMap(([part, clock]) => [
          [`--lava-${part}-duration`, `${clock.duration}s`],
          [`--lava-${part}-delay`, `${clock.delay}s`],
        ])),
        ...(mood === 'busy' ? Object.fromEntries(Object.entries(working).flatMap(([part, clock]) => [
          [`--lava-${part}-animation`, `${uid}-lava-${part}`],
          [`--lava-${part}-duration`, `${clock.duration}s`],
          [`--lava-${part}-delay`, `${clock.delay}s`],
        ])) : {}),
        ['--lava-dx' as string]: `${geometry.budTravel.dx.toFixed(2)}px`,
        ['--lava-dy' as string]: `${geometry.budTravel.dy.toFixed(2)}px`,
        // A cold lamp's rim goes grey with its body rather than keeping the hue it lost.
        ['--lava-rim' as string]: cold ? COLD_DEEP : `color-mix(in srgb, ${body} 60%, ${colors.deep})`,
      }}
    >
      {mood === 'busy' ? <style>{Object.entries(working).map(([part, clock]) =>
        `@keyframes ${uid}-lava-${part}{${clock.keyframes}}`).join('')}</style> : null}
      <svg viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
        <defs>
          {/* Pools are soft-edged gradients rather than one blurred group: a pool belongs to its
              lobe and has to travel with it, and a gradient costs nothing where a filter per lobe
              would repaint the whole blob again. Inside an opaque body they only ever blend colour,
              so the goo's alpha threshold never sees them. */}
          {TONES.map((tone) => (
            <radialGradient key={tone} id={`${uid}-${tone}`}>
              <stop offset="0%" stopColor={colors[tone]} />
              <stop offset={tone === 'glow' ? '38%' : '52%'} stopColor={colors[tone]} />
              <stop offset="100%" stopColor={colors[tone]} stopOpacity="0" />
            </radialGradient>
          ))}
          <filter
            id={`${uid}-goo`}
            filterUnits="userSpaceOnUse"
            x={-14}
            y={-14}
            width={128}
            height={128}
            colorInterpolationFilters="sRGB"
          >
            {/* Melt: blur everything, then cut the alpha back to a hard edge. Overlapping lobes
                come out as one body with smooth necks; colours keep the blur's soft blend. */}
            <feGaussianBlur in="SourceGraphic" stdDeviation={LAVA_GOO} result="melt" />
            <feColorMatrix
              in="melt"
              type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -9"
              result="goo"
            />
            {/* Error: the lamp has gone cold. Drained of colour but still the same lump. */}
            {cold ? <feColorMatrix in="goo" type="saturate" values="0.12" result="goo" /> : null}

            {/* Print grain: one noise field, read as alpha. */}
            <feTurbulence
              type="fractalNoise"
              baseFrequency={grain}
              numOctaves={2}
              seed={noiseSeed}
              result="noise"
            />
            <feColorMatrix
              in="noise"
              type="matrix"
              values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0"
              result="grain"
            />
            {/* A translucent shade of the body gives the rim definition on light and dark surfaces.
                Standalone SVGs use the same hue family without requiring theme CSS. */}
            <feFlood style={{ floodColor: `var(--lava-rim, ${cold ? COLD_DEEP : colors.deep})` }} floodOpacity={0.68} result="ink" />

            {/* The inner ramp: strongest at the edge, fading inward, deepest in the necks (a concave
                spot sees more outside, so its blurred alpha is lower). */}
            <feGaussianBlur in="goo" stdDeviation={4} result="gooSoft" />
            <feComposite in="goo" in2="gooSoft" operator="out" result="ramp" />
            {/* The body's own colour, multiplied by itself: the deeper, more saturated tone the
                body passes through on the way to the translucent rim. */}
            <feBlend in="goo" in2="goo" mode="multiply" result="deep" />
            <feComposite in="ramp" in2="ramp" operator="arithmetic" k2={1.4} result="deepMask" />
            <feComposite in="deep" in2="deepMask" operator="in" result="deepRim" />
            {/* Stipple the ramp against the grain, so the ink breaks up as it reaches inward. */}
            <feComposite in="ramp" in2="grain" operator="arithmetic" k2={12} k3={-8} k4={1.1} result="stipple" />
            <feComposite in="ink" in2="stipple" operator="in" result="inkStipple" />
            <feComposite in="inkStipple" in2="goo" operator="in" result="inkInside" />

            {/* The rim itself: a solid band just inside the silhouette. */}
            <feMorphology in="goo" operator="erode" radius={rim} result="core" />
            <feComposite in="goo" in2="core" operator="out" result="band" />
            <feComposite in="ink" in2="band" operator="in" result="inkBand" />

            {/* And just outside it, grain: the ink bleeding into the paper. */}
            <feMorphology in="goo" operator="dilate" radius={1.3} result="spread" />
            <feGaussianBlur in="spread" stdDeviation={0.8} result="spreadSoft" />
            <feComposite in="spreadSoft" in2="goo" operator="out" result="bleed" />
            <feComposite in="bleed" in2="grain" operator="arithmetic" k2={4.8} k3={-8} k4={1.6} result="bleedGrain" />
            {/* Confined to the spread: unconfined, the darkest grains far out on the paper drew too. */}
            <feComposite in="bleedGrain" in2="bleed" operator="in" result="bleedNear" />
            <feComposite in="ink" in2="bleedNear" operator="in" result="inkBleed" />

            {bodyGrain ? (
              <>
                {/* Film grain over the body: the darkest and lightest grains, faint. */}
                <feComposite in="grain" in2="grain" operator="arithmetic" k2={3} k4={-1.95} result="darkSpecks" />
                <feComposite in="ink" in2="darkSpecks" operator="in" result="darkInk" />
                <feComposite in="darkInk" in2="goo" operator="in" result="darkGrain" />
                <feComposite in="grain" in2="grain" operator="arithmetic" k2={-3} k4={1.14} result="lightSpecks" />
                <feFlood floodColor="#ffffff" floodOpacity={0.6} result="paper" />
                <feComposite in="paper" in2="lightSpecks" operator="in" result="lightInk" />
                <feComposite in="lightInk" in2="goo" operator="in" result="lightGrain" />
              </>
            ) : null}

            <feMerge>
              <feMergeNode in="goo" />
              {bodyGrain ? <feMergeNode in="lightGrain" /> : null}
              {bodyGrain ? <feMergeNode in="darkGrain" /> : null}
              <feMergeNode in="deepRim" />
              <feMergeNode in="inkInside" />
              <feMergeNode in="inkBand" />
              <feMergeNode in="inkBleed" />
            </feMerge>
          </filter>
        </defs>


        <g filter={`url(#${uid}-goo)`}>
          {/* One wrapper for the whole goo, so the lamp's rise carries every lobe and pool at once. */}
          <g className="blob-lava-rise">
            {/* Bodies first, then their pools: a pool painted inside a lobe must not be buried by a
                neighbouring lobe drawn later that overlaps it. The main body and its own pools are
                wrapped in separate `blob-lava-core` groups so the two swell together without giving
                up that order — identical animations on the same origin, so they stay locked. */}
            <g className="blob-lava-core" style={{ transformOrigin: at(mainBody.lobe) }}>
              <circle cx={mainBody.lobe.cx} cy={mainBody.lobe.cy} r={mainBody.lobe.r} fill={body} />
            </g>
            {middles.map((entry, index) => (
              <circle
                key={index}
                className="blob-lava-lobe"
                style={lobeStyle(entry, index + 1)}
                cx={entry.lobe.cx}
                cy={entry.lobe.cy}
                r={entry.lobe.r}
                fill={body}
              />
            ))}
            <circle
              className="blob-lava-bud"
              style={lobeStyle(bud, budIndex)}
              cx={bud.lobe.cx}
              cy={bud.lobe.cy}
              r={bud.lobe.r}
              fill={body}
            />

            <g className="blob-lava-core" style={{ transformOrigin: at(mainBody.lobe) }}>
              {mainPools.length ? (
                <g className="blob-lava-pools" style={{ transformOrigin: at(swirl) }}>
                  {pools(mainPools)}
                </g>
              ) : null}
              {mainGlow.length ? (
                <g className="blob-lava-glow" style={{ transformOrigin: at(swirl) }}>
                  {pools(mainGlow)}
                </g>
              ) : null}
            </g>
            {middles.map((entry, index) => (
              <g key={index} className="blob-lava-lobe" style={lobeStyle(entry, index + 1)}>
                {pools(entry.pools)}
              </g>
            ))}
            {bud.pools.length ? (
              <g className="blob-lava-bud" style={lobeStyle(bud, budIndex)}>
                {pools(bud.pools)}
              </g>
            ) : null}
          </g>
        </g>

        <MoodBadge mood={mood} inset={-2} />
      </svg>
    </div>
  );
}
