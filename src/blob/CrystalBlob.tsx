import * as React from 'react';
import { hashString, mulberry32, seedIdentity } from './seed';
import { IDENTITY_COLORS } from './contrast';
import { CRYSTAL_SHAPES, crystalGeometry } from './crystal';
import { MoodBadge, ThinkingArc } from './overlays';
import { OrbitRing } from './OrbitRing';
import type { AvatarIdentity, BallMood, BallState } from '../types';
import './blob.css';

type Props = {
  seed: string;
  identity?: AvatarIdentity;
  size?: number;
  state?: BallState;
  mood?: BallMood;
  interactive?: boolean;
};

/** A cold lump: what an ember looks like after the fire has gone out. */
const COLD = 'var(--muted-foreground)';

/**
 * Crystal — a faceted lump of the session's colour. Mood is heat, and heat is the only thing the
 * style draws beyond the lump itself: inert when idle, roaring when busy, amber when it wants you,
 * cold grey when the turn failed. Every mood sets the halo statically, so the state still reads in
 * a still frame and under `prefers-reduced-motion`, where only the pulse is dropped.
 */
export default function CrystalBlob({
  seed,
  identity,
  size = 30,
  mood = 'idle',
  state = 'idle',
}: Props) {
  // Gradient and clip ids must be unique per instance; useId contains colons, illegal in url().
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');

  const { geometry, body, glow } = React.useMemo(() => {
    const resolved = identity ?? seedIdentity(seed);
    const shapeRng = mulberry32(hashString(`crystal:${resolved.shapeSeed}`));
    const colorRng = mulberry32(hashString(`crystal:${resolved.colorSeed}`));
    const motionRng = mulberry32(hashString(`crystal:${resolved.motionSeed}`));
    // Consumed in the same order as blobColor(), so the rail dot matches the lump.
    const colorIndex =
      resolved.colorIndex ?? Math.floor(colorRng() * IDENTITY_COLORS.length);
    const index = Math.abs(colorIndex) % IDENTITY_COLORS.length;
    return {
      geometry: crystalGeometry(
        shapeRng,
        motionRng,
        CRYSTAL_SHAPES.find((entry) => entry.name === resolved.shapeName)
      ),
      body: index === undefined ? COLD : `var(--blob-${index})`,
      glow: `var(--blob-${index})`,
    };
  }, [identity, seed]);

  const cold = mood === 'error';
  const ink = cold ? COLD : body;
  // Heat colour per mood: the accent takes over when the blob is asking for something.
  const heat =
    cold ? COLD : mood === 'input' ? 'var(--warning)' : mood === 'question' ? 'var(--highlight)' : glow;

  return (
    <div
      className="blob blob-crystal"
      data-mood={mood}
      data-state={state}
      aria-hidden="true"
      style={{ width: size, height: size, animationDelay: `${geometry.heatDelay}s` }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
        <defs>
          <radialGradient id={`${uid}-heat`}>
            <stop offset="0.68" stopColor={heat} stopOpacity="0.9" />
            <stop offset="1" stopColor={heat} stopOpacity="0" />
          </radialGradient>
          <clipPath id={`${uid}-lump`}>
            <path d={geometry.body} />
          </clipPath>
        </defs>

        {state === 'needs-input' ? <OrbitRing.Back cx={50} cy={50} r={46} /> : null}

        <circle className="blob-heat" cx={50} cy={50} r={48} fill={`url(#${uid}-heat)`} />

        <g className="blob-body" transform={`rotate(${geometry.tilt} 50 50)`}>
          <path d={geometry.body} fill={ink} />
          {/* Clipped, because a plane hangs off its two rim vertices and would otherwise poke
              past the silhouette. */}
          <g clipPath={`url(#${uid}-lump)`}>
            {geometry.facets.map((facet, index) => (
              <path
                key={index}
                d={facet.d}
                fill={facet.kind === 'shade' ? '#000000' : '#ffffff'}
                opacity={facet.kind === 'lit' ? 0.2 : facet.kind === 'shade' ? 0.18 : 0.1}
              />
            ))}
          </g>
        </g>

        {mood === 'thinking' ? <ThinkingArc radius={52} /> : null}
        <MoodBadge mood={mood} inset={-2} />
        {state === 'needs-input' ? <OrbitRing.Front cx={50} cy={50} r={46} /> : null}
      </svg>
    </div>
  );
}
