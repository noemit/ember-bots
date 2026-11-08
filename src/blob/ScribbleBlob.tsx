import * as React from 'react';
import { blobColor } from './color';
import { hashString, seedIdentity } from './seed';
import { scribbleGeometry } from './scribble';
import { scribbleEyes } from './scribbleEyes';
import { usePupilTracking } from './usePupilTracking';
import { MoodBadge } from './overlays';
import type { AvatarIdentity, BallMood, BallState } from '../types';
import './blob.css';
import './blob-scribble.css';

// Low lids still leave a little vertical cursor response without losing the pupil.
const constrainGaze = (x: number, y: number): [number, number] => [x, y * .15];

type Props = { seed: string; identity?: AvatarIdentity; size?: number; mood?: BallMood; state?: BallState; interactive?: boolean };

export default function ScribbleBlob({ seed, identity, size = 30, mood = 'idle', interactive = true }: Props) {
  const eyeId = React.useId().replace(/:/g, '');
  const eyes = scribbleEyes(mood);
  const wrapper = React.useRef<HTMLDivElement>(null);
  const left = React.useRef<SVGGElement>(null);
  const right = React.useRef<SVGGElement>(null);
  const art = React.useMemo(() => {
    const resolved = identity ?? seedIdentity(seed);
    return { ...scribbleGeometry(resolved), color: blobColor('scribble', resolved), delay: -(hashString(resolved.motionSeed) % 16000) / 1000 };
  }, [identity, seed]);
  usePupilTracking(wrapper, [left, right], interactive && !['unknown', 'error', 'thinking'].includes(mood), 1.8, constrainGaze);
  const dark = `color-mix(in srgb, ${art.color} 65%, #211925)`;
  return <div ref={wrapper} className="blob blob-scribble" data-mood={mood} data-shape={art.name} aria-hidden="true" style={{ width: size, height: size, '--scribble-delay': `${art.delay}s` } as React.CSSProperties}>
    <div className="scribble-dance">
      <svg viewBox="0 0 100 100" width={size} height={size}>
        {/* Legs are painted behind the body and start inside its core, so moving wires never expose cut ends. */}
        <g className="scribble-foot scribble-foot-left">
          <path d={`M43 43 Q${42 + art.legLean} 76 42 92`} stroke={dark} strokeWidth={1.8} strokeLinecap="round" fill="none" />
          <ellipse cx={41} cy={92} rx={4} ry={2.1} fill={dark} />
        </g>
        <g className="scribble-foot scribble-foot-right">
          <path d={`M57 43 Q${59 + art.legLean} 79 59 92`} stroke={dark} strokeWidth={1.8} strokeLinecap="round" fill="none" />
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
                {eyes.map((eye, index) => <g key={index} transform={`translate(${eye.x} ${eye.y})`}>
                  <path className="scribble-brow" d={eye.brow} fill="none" stroke="#211925" strokeWidth={2} strokeLinecap="round" />
                  <g className="scribble-eye-blink">
                    <defs><clipPath id={`${eyeId}-eye-${index}`}><path d={eye.outline} /></clipPath></defs>
                    <path data-scribble-eye d={eye.outline} fill="#fffdf5" stroke="#29212f" strokeWidth={1.8} />
                    <g clipPath={`url(#${eyeId}-eye-${index})`}>
                      <g ref={index ? right : left} className="scribble-pupil">
                        <g className="scribble-gaze" style={{ '--eye-x': `${eye.gaze[0]}px`, '--eye-y': `${eye.gaze[1]}px` } as React.CSSProperties}>
                          {mood === 'error'
                            ? <path d="M-2.8 -2.5L2.8 2.5M2.8 -2.5L-2.8 2.5" fill="none" stroke="#211925" strokeWidth={2} strokeLinecap="round" />
                            : <ellipse rx={eye.pupil} ry={eye.pupil + .35} fill="#211925" />}
                        </g>
                      </g>
                    </g>
                  </g>
                </g>)}
              </g>
            </g>
          </g>
          {/* The raised hand is an invitation to respond, reserved for a question. */}
          {mood === 'question' ? <g className="scribble-wave" opacity={1} fill="none" stroke={dark} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <g transform="translate(100 0) scale(-1 1)">
              <path d="M66 55 Q88 52 83 37 Q81 27 71 24" />
              <g className="scribble-fingers">
                <path d="M73 26l-6-6m7 5l-3-8m4 8l1-7" />
              </g>
            </g>
          </g> : null}
        </g>
      </svg>
    </div>
    <svg className="blob-overlay" viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
      <MoodBadge size={size} mood={mood} />
    </svg>
  </div>;
}
