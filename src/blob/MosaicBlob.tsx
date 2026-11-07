import * as React from 'react';
import { seedIdentity, hashString } from './seed';
import { blobColor } from './color';
import { mosaicActivityPixels, mosaicGeometry, mosaicTileColor } from './mosaic';
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
  // Each eye is two cells wide and one high: a pupil can change columns, never leave its row.
  const mapPupilOffset = React.useCallback((x: number): [number, number] =>
    [Math.round(x + .5) - (art.lookRight ? 1 : 0), 0], [art.lookRight]);
  usePupilTracking(wrapper, [left, right], interactive && !['unknown', 'error', 'thinking'].includes(mood), .5,
    mapPupilOffset);
  return <div ref={wrapper} className="blob blob-mosaic" data-mood={mood} data-shape={art.name} aria-hidden="true" style={{ width: size, height: size,
    '--mosaic-eye-delay': `${art.eyeDelay}s`, '--mosaic-gaze-step': art.lookRight ? '-1px' : '1px',
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
          <g className="mosaic-eyes">{(mood === 'error' ? art.errorEyes : [3, 6].map(x => ({ x, y: art.eyeY }))).map(({ x, y }) => <g key={x}>
            <g className="mosaic-eye-open">
              <rect x={x} y={y} width={mood === 'error' ? 3 : 2} height={mood === 'error' ? 3 : 1} fill="#fffdf5" />
              {mood === 'error' ? <g className="mosaic-error-eye" fill="#14111a">
                {[[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]].map(([dx, dy]) =>
                  <rect key={`${dx}:${dy}`} x={x + dx} y={y + dy} width={1} height={1} />)}
              </g>
                : <g ref={x === 3 ? left : right} className="mosaic-pupil"><rect x={x + (art.lookRight ? 1 : 0)} y={y} width={1} height={1} fill="#14111a" /></g>}
            </g>
            <rect className="mosaic-eye-closed" x={x} y={y} width={2} height={1} fill="#14111a" opacity={0} />
          </g>)}</g>
        </g>
      </svg>
    </div>
    <svg className="blob-overlay" viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
      <MoodBadge mood={mood} inset={mood === 'error' ? -4 : 0} />
    </svg>
  </div>;
}
