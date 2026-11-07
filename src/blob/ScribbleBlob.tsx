import * as React from 'react';
import { blobColor } from './color';
import { hashString, seedIdentity } from './seed';
import { scribbleGeometry } from './scribble';
import { usePupilTracking } from './usePupilTracking';
import { MoodBadge, ThinkingArc } from './overlays';
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
    return { ...scribbleGeometry(resolved), color: blobColor('scribble', resolved), delay: -(hashString(resolved.motionSeed) % 2000) / 1000 };
  }, [identity, seed]);
  usePupilTracking(wrapper, [left, right], interactive && mood !== 'unknown' && mood !== 'error', 2);
  const dark = `color-mix(in srgb, ${art.color} 65%, #211925)`;
  return <div ref={wrapper} className="blob blob-scribble" data-mood={mood} data-shape={art.name} aria-hidden="true" style={{ width: size, height: size }}>
    <div className="scribble-dance" style={{ animationDelay: `${art.delay}s` }}>
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <g stroke={dark} strokeWidth={1.8} strokeLinecap="round" fill="none">
          <path d={`M43 61 Q${42 + art.legLean} 76 42 92 M57 61 Q${59 + art.legLean} 79 59 92`} />
        </g>
        <ellipse cx={41} cy={92} rx={4} ry={2.1} fill={dark} />
        <ellipse cx={60} cy={92} rx={4.3} ry={2} fill={dark} />
        <g strokeLinecap="round" strokeLinejoin="round" fill="none">
          {art.strokes.map((stroke, i) => <path key={i} d={stroke.path} stroke={stroke.shade ? dark : art.color} strokeWidth={stroke.width} />)}
        </g>
        <path d={art.core} fill={art.color} />
        <g transform={`rotate(${art.eyeTilt} 50 44)`}>
          {[{ x: 42, y: 42, radius: 7.7, ref: left }, { x: 59, y: 46, radius: 5.9, ref: right }].map(eye => <g key={eye.x} transform={`translate(${eye.x} ${eye.y})`}>
            <ellipse data-scribble-eye rx={eye.radius} ry={eye.radius * 1.08} fill="#fffdf5" stroke="#29212f" strokeWidth={1.8} />
            <g ref={eye.ref}>
              {mood === 'error' ? <path d="M-2 -2L2 2M2 -2L-2 2" fill="none" stroke="#211925" strokeWidth={1.6} /> : <circle r={1.7} fill="#211925" />}
            </g>
          </g>)}
        </g>
      </svg>
    </div>
    <svg className="blob-overlay" viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
      {mood === 'thinking' ? <ThinkingArc /> : null}
      <MoodBadge mood={mood} />
    </svg>
  </div>;
}
