import * as React from 'react';
import { hashString, mulberry32, seedIdentity } from './seed';
import { IDENTITY_COLORS } from './contrast';
import { CRYSTAL_SHAPES, crystalGeometry } from './crystal';
import { accentFor, MoodBadge } from './overlays';
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

/** A stationary cut stone: working and thinking show only light travelling across its facets.
 * Attention keeps its static halo and badge; a failed turn keeps the cold stone and error badge. */
export default function CrystalBlob({
  seed,
  identity,
  size = 30,
  mood = 'idle',
  state = 'idle',
}: Props) {
  // Gradient and clip ids must be unique per instance; useId contains colons, illegal in url().
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');

  const { geometry, body } = React.useMemo(() => {
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
      body: resolved.color ?? `var(--blob-${index})`,
    };
  }, [identity, seed]);

  const cold = mood === 'error';
  const ink = cold ? COLD : body;
  const reflecting = mood === 'busy' || mood === 'thinking';
  const attention = mood === 'input' || mood === 'question';
  const heat = accentFor(mood);

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
          {attention ? <filter id={`${uid}-heat`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation={3} />
          </filter> : null}
          <linearGradient id={`${uid}-reflection`} x1="0" y1="0" x2="1" y2=".2">
            <stop offset="0" stopColor="white" stopOpacity="0" />
            <stop offset=".35" stopColor="white" stopOpacity=".06" />
            <stop offset=".5" stopColor="white" stopOpacity=".7" />
            <stop offset=".62" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${uid}-lump`}>
            <path d={geometry.body} />
          </clipPath>
          {reflecting ? geometry.facets.map((facet, index) => (
            <clipPath key={index} id={`${uid}-facet-${index}`}>
              <path d={facet.d} />
            </clipPath>
          )) : null}
        </defs>

        {state === 'needs-input' ? <OrbitRing.Back cx={50} cy={50} r={46} /> : null}

        {attention ? <g className="blob-heat" opacity={0}><path d={geometry.body} fill={heat} stroke={heat} strokeWidth={5}
          filter={`url(#${uid}-heat)`} transform={`rotate(${geometry.tilt} 50 50)`} /></g> : null}

        <g className="blob-body" transform={`rotate(${geometry.tilt} 50 50)`}>
          <path d={geometry.body} fill={ink} />
          {/* The mesh covers the whole polygon; clipping trims its rounded outer corners. */}
          <g clipPath={`url(#${uid}-lump)`}>
            {geometry.facets.map((facet, index) => (
              <path
                key={index}
                data-crystal-facet={index}
                className={facet.kind === 'shade' ? undefined : 'crystal-glint'}
                style={{ animationDelay: `${geometry.heatDelay - index * .38}s` }}
                d={facet.d}
                fill={facet.kind === 'shade' ? '#000000' : '#ffffff'}
                opacity={facet.opacity}
              />
            ))}
            {reflecting ? <g className="crystal-working-light">
              {geometry.facets.map((facet, index) => (
                <g key={index} clipPath={`url(#${uid}-facet-${index})`}
                  opacity={facet.kind === 'lit' ? 1 : facet.kind === 'soft' ? .65 : .35}
                  style={{ '--crystal-facet-delay': `${geometry.heatDelay + (facet.kind === 'lit' ? 0 : facet.kind === 'soft' ? .65 : 1.3)}s` } as React.CSSProperties}>
                  <path className="crystal-working-facet" d={facet.d} fill="white" opacity={0} />
                  <g transform={facet.reflectionTransform}>
                    <rect className="crystal-reflection-sweep" x={-100} y={-100} width={100} height={200}
                      fill={`url(#${uid}-reflection)`} opacity={0} />
                  </g>
                </g>
              ))}
            </g> : null}
          </g>
          {reflecting ? <g fill="white" stroke={ink} strokeWidth={.35}>
            {geometry.vertices.slice(geometry.rimCount).map(([x, y], index) => (
              <path key={index} className="crystal-sparkle"
                d={`M${x} ${y - 4} Q${x + .8} ${y - .8} ${x + 4} ${y} Q${x + .8} ${y + .8} ${x} ${y + 4} Q${x - .8} ${y + .8} ${x - 4} ${y} Q${x - .8} ${y - .8} ${x} ${y - 4}Z`}
                style={{ animationDelay: `${geometry.heatDelay - index * 2.1}s` }} />
            ))}
          </g> : null}
        </g>

        <MoodBadge size={size} mood={mood} inset={-2} />
        {state === 'needs-input' ? <OrbitRing.Front cx={50} cy={50} r={46} /> : null}
      </svg>
    </div>
  );
}
