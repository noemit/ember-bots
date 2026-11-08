import * as React from 'react';
import { seedIdentity, hashString } from './seed';
import { blobColor } from './color';
import { MOSAIC_EYES, MOSAIC_PUPIL_REACH, mosaicActivityPixels, mosaicGeometry, mosaicTileColor } from './mosaic';
import { MoodBadge } from './overlays';
import { usePupilTracking } from './usePupilTracking';
import type { AvatarIdentity, BallMood, BallState } from '../types';
import './blob.css';
import './blob-mosaic.css';

type Props = { seed: string; identity?: AvatarIdentity; size?: number; mood?: BallMood; state?: BallState; interactive?: boolean };

export default function MosaicBlob({ seed, identity, size = 30, mood = 'idle', interactive = true }: Props) {
  const wrapper = React.useRef<HTMLDivElement>(null);
  const left = React.useRef<SVGGElement>(null);
  const right = React.useRef<SVGGElement>(null);
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const art = React.useMemo(() => {
    const resolved = identity ?? seedIdentity(seed);
    const base = blobColor('mosaic', resolved);
    const geometry = mosaicGeometry(resolved);
    return { ...geometry, base,
      tiles: geometry.cells.map(cell => ({ ...cell, fill: mosaicTileColor(base, cell.band, cell.y, resolved.colorSeed) })),
      pixels: mosaicActivityPixels(geometry.cells).map(pixel => ({ ...pixel, fill: mosaicTileColor(base, Math.max(0, Math.min(11, pixel.x)), pixel.y, resolved.colorSeed) })),
      delay: -(hashString(resolved.motionSeed) % 2400) / 1000,
      eyeDelay: -(hashString(`mosaic-eyes:${resolved.motionSeed}`) % 10800) / 1000 };
  }, [identity, seed]);
  usePupilTracking(wrapper, [left, right], interactive && !['unknown', 'error', 'thinking'].includes(mood), MOSAIC_PUPIL_REACH);
  return <div ref={wrapper} className="blob blob-mosaic" data-mood={mood} data-shape={art.name} aria-hidden="true" style={{ width: size, height: size,
    '--mosaic-eye-delay': `${art.eyeDelay}s`,
  } as React.CSSProperties}>
    <div className="mosaic-step" style={{ animationDelay: `${art.delay}s` }}>
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <g data-mosaic-grid transform="translate(8 1) scale(7)" shapeRendering="crispEdges">
          {art.tiles.map(({ x, y, fill }) => <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill={fill} />)}
          {mood === 'thinking' ? art.tiles.map(({ x, y }) => <rect key={`thought:${x}:${y}`}
            className="mosaic-thought" x={x} y={y} width={1} height={1} fill="#fffdf5" opacity={0}
            style={{ animationDelay: `${art.delay - (x + y % 3) * .18}s` }} />) : null}
          {mood === 'busy' ? art.pixels.map(({ x, y, fill, side, distance, delay }) => <rect
            key={`${side}:${x}:${y}`} className="mosaic-pixel" data-side={side === -1 ? 'left' : 'right'}
            x={x} y={y} width={1} height={1} fill={fill}
            style={{ animationDelay: `${art.delay - delay}s`, animationName: distance === 1 ? 'mosaic-pixel-near' : 'mosaic-pixel-far' }} />) : null}
          {mood === 'error' ? art.errorEyes.map(({ x, y }) => <g key={x}>
              <rect x={x} y={y} width={3} height={3} fill="#fffdf5" />
              <g className="mosaic-error-eye" fill="#14111a">
                {[[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]].map(([dx, dy]) =>
                  <rect key={`${dx}:${dy}`} x={x + dx} y={y + dy} width={1} height={1} />)}
              </g>
          </g>) : null}
        </g>
        {mood !== 'error' ? <g transform={`translate(${art.face.x} ${art.face.y}) scale(${art.face.scale})`}>
          <g className="mosaic-eyes">{MOSAIC_EYES.map((eye, index) => <g key={index} transform={`translate(${eye.x} ${eye.y})`}>
            <defs><clipPath id={`${uid}-eye-${index}`}><path d={eye.path} /></clipPath></defs>
            <g className="mosaic-eye-open">
              <path data-mosaic-eye d={eye.path} fill="#fffdf5" stroke="#302633" strokeWidth={1.1} />
              <g clipPath={`url(#${uid}-eye-${index})`}>
                <g ref={index === 0 ? left : right} className="mosaic-pupil">
                  <circle r={eye.pupilRadius} fill="#211925" />
                  <circle cx={-2} cy={-2.3} r={1.6} fill="#fffdf5" />
                </g>
              </g>
            </g>
            <path className="mosaic-eye-closed" d="M-9 1 Q0 5 9 0" fill="none" stroke="#211925" strokeWidth={2.8} strokeLinecap="round" opacity={0} />
          </g>)}</g>
        </g> : null}
      </svg>
    </div>
    <svg className="blob-overlay" viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
      <MoodBadge size={size} mood={mood} inset={mood === 'error' ? -4 : 0} />
    </svg>
  </div>;
}
