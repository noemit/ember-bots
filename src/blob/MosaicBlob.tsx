import * as React from 'react';
import { seedIdentity, hashString } from './seed';
import { mosaicActivityPixels, mosaicBaseHex, mosaicField, mosaicGeometry, mosaicSurfaces } from './mosaic';
import { getThemeRevision, subscribeTheme } from '../themes';
import { usePupilTracking } from './usePupilTracking';
import { MoodBadge } from './overlays';
import { faceCoversEyes, faceFor, facePixels, identityForFace } from './mosaicFace';
import type { AvatarIdentity, BallMood, BallState } from '../types';
import './blob.css';
import './blob-mosaic.css';

type Props = { seed: string; identity?: AvatarIdentity; size?: number; mood?: BallMood; state?: BallState; interactive?: boolean };

export default function MosaicBlob({ seed, identity, size = 30, mood = 'idle', interactive = true }: Props) {
  const wrapper = React.useRef<HTMLDivElement>(null);
  const left = React.useRef<SVGGElement>(null);
  const right = React.useRef<SVGGElement>(null);
  // The field needs concrete theme colours, so a theme change has to re-run this math.
  const themeRevision = React.useSyncExternalStore(subscribeTheme, getThemeRevision, getThemeRevision);
  const art = React.useMemo(() => {
    const base = identity ?? seedIdentity(seed);
    /**
     * The face decides the body.
     *
     * A face is a composition — a hat needs the silhouette it was drawn for — so the resolved
     * identity takes its `shapeName` from the face rather than from shape allocation. Colour is left
     * alone: the session keeps its own, which is what lets two sessions share a face and still read
     * as two people.
     *
     * `taken` is not threaded through here. The rail already spreads colour, and a face repeating is
     * acceptable by design; the walk in `faceFor` exists for callers that can cheaply say which
     * faces are on screen, which a single blob cannot.
     */
    const face = faceFor(base);
    const resolved = identityForFace(base, face);
    const accessory = facePixels(face);
    const hideEyes = faceCoversEyes(face);
    const geometry = mosaicGeometry(resolved);
    const field = mosaicField(mosaicBaseHex(resolved), geometry.cells, resolved.colorSeed, mosaicSurfaces(themeRevision));
    return { ...geometry,
      tiles: geometry.cells.map((cell, i) => ({ ...cell, fill: field.colors[i] })),
      // Side pixels keep their existing flicker; borrowing the nearest body pigment keeps them in
      // the same colour family without adding them to the neighbour-cap measurements.
      pixels: mosaicActivityPixels(geometry.cells).map(pixel => {
        let nearest = 0;
        geometry.cells.forEach((cell, i) => {
          if (Math.hypot(cell.x - pixel.x, cell.y - pixel.y) < Math.hypot(geometry.cells[nearest].x - pixel.x, geometry.cells[nearest].y - pixel.y)) nearest = i;
        });
        return { ...pixel, fill: field.colors[nearest] };
      }),
      accessory,
      hideEyes,
      bodyShift: face.bodyShift ?? 0,
      delay: -(hashString(resolved.motionSeed) % 2400) / 1000,
      eyeDelay: -(hashString(`mosaic-eyes:${resolved.motionSeed}`) % 10800) / 1000 };
  }, [identity, seed, themeRevision]);
  // A two-cell white has only two legal pupil positions. No interpolation off the grid.
  const snapGaze = React.useCallback((x: number): [number, number] =>
    [(x >= 0 ? 1 : 0) - (art.lookRight ? 1 : 0), 0], [art.lookRight]);
  usePupilTracking(wrapper, [left, right], interactive && mood !== 'error' && mood !== 'unknown', 1, snapGaze);
  return <div ref={wrapper} className="blob blob-mosaic" data-mood={mood} data-shape={art.name} aria-hidden="true" style={{ width: size, height: size,
    '--mosaic-eye-delay': `${art.eyeDelay}s`, '--mosaic-gaze-step': art.lookRight ? '-1px' : '1px',
  } as React.CSSProperties}>
    <div className="mosaic-step" style={{ animationDelay: `${art.delay}s` }}>
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <g data-mosaic-grid transform="translate(8 1) scale(7)" shapeRendering="crispEdges">
          {art.tiles.map(({ x, y, fill }) => <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill={fill} />)}
          {art.accessory.map(({ x, y, fill, anim }, index) => <rect
            key={`acc:${index}`}
            className={anim ? `mosaic-anim-${anim === 'screenIdle' ? 'screen-idle' : anim}` : undefined}
            x={x} y={y} width={1} height={1} fill={fill} />)}
          {mood === 'thinking' ? art.tiles.map(({ x, y }) => <rect key={`thought:${x}:${y}`}
            className="mosaic-thought" x={x} y={y} width={1} height={1} fill="#fffdf5" opacity={0}
            style={{ animationDelay: `${art.delay - (x + y % 3) * .18}s` }} />) : null}
          {mood === 'busy' ? art.pixels.map(({ x, y, fill, side, distance, delay }) => <rect
            key={`${side}:${x}:${y}`} className="mosaic-pixel" data-side={side === -1 ? 'left' : 'right'}
            x={x} y={y} width={1} height={1} fill={fill}
            style={{ animationDelay: `${art.delay - delay}s`, animationName: distance === 1 ? 'mosaic-pixel-near' : 'mosaic-pixel-far' }} />) : null}
          {art.hideEyes ? null : <g className="mosaic-eyes">{(mood === 'error' ? art.errorEyes : art.eyes).map(({ x, y }, index) => <g key={x}>
            <g className="mosaic-eye-open">
              <rect data-mosaic-eye x={x} y={y} width={mood === 'error' ? 3 : 2} height={mood === 'error' ? 3 : 1} fill="#fffdf5" />
              {mood === 'error' ? <g className="mosaic-error-eye" fill="#14111a">
                {[[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]].map(([dx, dy]) =>
                  <rect key={`${dx}:${dy}`} x={x + dx} y={y + dy} width={1} height={1} />)}
              </g>
                : <g ref={index === 0 ? left : right} className="mosaic-pupil"><rect x={x + (art.lookRight ? 1 : 0)} y={y} width={1} height={1} fill="#14111a" /></g>}
            </g>
            <rect className="mosaic-eye-closed" x={x} y={y} width={2} height={1} fill="#14111a" opacity={0} />
          </g>)}</g>}
        </g>
      </svg>
    </div>
    <svg className="blob-overlay" viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
      <MoodBadge size={size} mood={mood} inset={mood === 'error' ? -4 : 0} />
    </svg>
  </div>;
}
