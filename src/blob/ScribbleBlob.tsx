import * as React from 'react';
import { blobColor } from './color';
import { hashString, seedIdentity } from './seed';
import { scribbleGeometry } from './scribble';
import { usePupilTracking } from './usePupilTracking';
import { MoodBadge } from './overlays';
import type { AvatarIdentity, BallMood, BallState } from '../types';
import './blob.css';
import './blob-scribble.css';

type Props = { seed: string; identity?: AvatarIdentity; size?: number; mood?: BallMood; state?: BallState; interactive?: boolean };

export default function ScribbleBlob({ seed, identity, size = 30, mood = 'idle', interactive = true }: Props) {
  const wrapper = React.useRef<HTMLDivElement>(null);
  const left = React.useRef<SVGGElement>(null);
  const right = React.useRef<SVGGElement>(null);
  const art = React.useMemo(() => {
    const resolved = identity ?? seedIdentity(seed);
    return { ...scribbleGeometry(resolved), color: blobColor('scribble', resolved), delay: -(hashString(resolved.motionSeed) % 12000) / 1000 };
  }, [identity, seed]);
  usePupilTracking(wrapper, [left, right], interactive && !['unknown', 'error', 'thinking'].includes(mood), 2);
  const dark = `color-mix(in srgb, ${art.color} 65%, #211925)`;
  return <div ref={wrapper} className="blob blob-scribble" data-mood={mood} data-shape={art.name} aria-hidden="true" style={{ width: size, height: size, '--scribble-delay': `${art.delay}s` } as React.CSSProperties}>
    <div className="scribble-dance">
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <g className="scribble-foot scribble-foot-left">
          <path d={`M43 61 Q${42 + art.legLean} 76 42 92`} stroke={dark} strokeWidth={1.8} strokeLinecap="round" fill="none" />
          <ellipse cx={41} cy={92} rx={4} ry={2.1} fill={dark} />
        </g>
        <g className="scribble-foot scribble-foot-right">
          <path d={`M57 61 Q${59 + art.legLean} 79 59 92`} stroke={dark} strokeWidth={1.8} strokeLinecap="round" fill="none" />
          <ellipse cx={60} cy={92} rx={4.3} ry={2} fill={dark} />
        </g>
        <g className="scribble-turn">
          <g className="scribble-head">
            <g strokeLinecap="round" strokeLinejoin="round" fill="none">
              {Array.from({ length: art.strokes.length / 5 }, (_, ray) => <g key={ray} className="scribble-wire" style={{
                '--wire-angle': `${(ray % 2 ? -1 : 1) * (9 + ray % 5 * 3)}deg`,
                '--wire-think-delay': `${art.delay - ray * 0.19}s`,
              } as React.CSSProperties}>
                {art.strokes.slice(ray * 5, ray * 5 + 5).map((stroke, i) => <path key={i} d={stroke.path}
                  stroke={stroke.shade ? dark : art.color} strokeWidth={stroke.width}
                  strokeLinejoin={stroke.tip === 'sharp' ? 'miter' : 'round'} strokeLinecap={stroke.tip === 'sharp' ? 'butt' : 'round'} />)}
              </g>)}
            </g>
            <path d={art.core} fill={art.color} />
            <g className="scribble-knots" stroke={dark} strokeWidth={.7} opacity={.55} fill="none">
              {art.knots.map((path, i) => <path key={i} d={path} />)}
            </g>
            <g className="scribble-face">
              <g transform={`rotate(${art.eyeTilt} 50 44)`}>
                {[{ x: 42, y: 42, radius: 7.7, ref: left }, { x: 59, y: 46, radius: 5.9, ref: right }].map(eye => <g key={eye.x} transform={`translate(${eye.x} ${eye.y})`}>
                  <ellipse data-scribble-eye rx={eye.radius} ry={eye.radius * 1.08} fill="#fffdf5" stroke="#29212f" strokeWidth={1.8} />
                  <g ref={eye.ref} transform={mood === 'thinking' ? 'translate(0 0)' : undefined}>
                    {mood === 'error' ? <path d="M-2 -2L2 2M2 -2L-2 2" fill="none" stroke="#211925" strokeWidth={1.6} /> : <circle r={1.7} fill="#211925" />}
                  </g>
                </g>)}
              </g>
            </g>
          </g>
          {/* A loose ink arm emerges only for the scratch, keeping the idle silhouette intact. */}
          <g className="scribble-scratch" opacity={0} fill="none" stroke={dark} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M66 55 Q88 52 83 37 Q81 27 71 24" />
            <g className="scribble-fingers">
              <path d="M73 26l-6-6m7 5l-3-8m4 8l1-7" />
            </g>
          </g>
        </g>
      </svg>
    </div>
    <svg className="blob-overlay" viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
      <MoodBadge mood={mood} />
    </svg>
  </div>;
}
