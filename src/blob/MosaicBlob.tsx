import * as React from 'react';
import MosaicRainbow from './MosaicRainbow';
import MosaicActivity from './MosaicActivity';
import { seedIdentity, hashString } from './seed';
import { mosaicBaseHex, mosaicField, mosaicGeometry, mosaicSurfaces } from './mosaic';
import {
  MOSAIC_CACHE_LIMIT,
  createLruCache,
  normalizeAnimationScope,
  registerFrozenTiles,
} from './mosaicCache';
import type { ActivityCell } from './mosaicActivityPlan';
import { getThemeRevision, subscribeTheme } from '../themes';
import { usePupilTracking } from './usePupilTracking';
import { MoodBadge } from './overlays';
import type { AvatarIdentity, BallMood, BallState } from '../types';
import './blob.css';
import './blob-mosaic.css';

type Props = { seed: string; identity?: AvatarIdentity; size?: number; mood?: BallMood; state?: BallState; interactive?: boolean };

type MosaicArt = ReturnType<typeof mosaicGeometry> & {
  tiles: readonly (ActivityCell & { band: number })[];
  motionSeed: string;
  eyeDelay: number;
};

const mosaicArtCache = createLruCache<string, MosaicArt>(MOSAIC_CACHE_LIMIT);

function getOrCreateMosaicArt(resolved: AvatarIdentity, themeRevision: number): MosaicArt {
  const baseHex = mosaicBaseHex(resolved);
  const surfaces = mosaicSurfaces(themeRevision);
  const key = `${resolved.shapeSeed.length}:${resolved.shapeSeed}:${resolved.shapeName ?? ''}:${baseHex}:${surfaces.join(',')}:${resolved.motionSeed.length}:${resolved.motionSeed}`;
  const cached = mosaicArtCache.get(key);
  if (cached) return cached;
  const geometry = mosaicGeometry(resolved);
  const field = mosaicField(baseHex, geometry.cells, resolved.colorSeed, surfaces);
  const tiles = registerFrozenTiles(geometry.cells.map((cell, i) => ({ ...cell, fill: field.colors[i] })));
  const art: MosaicArt = {
    ...geometry,
    tiles,
    motionSeed: resolved.motionSeed,
    eyeDelay: -(hashString(`mosaic-eyes:${resolved.motionSeed}`) % 10800) / 1000,
  };
  return mosaicArtCache.set(key, art);
}

function MosaicBlobImpl({ seed, identity, size = 30, mood = 'idle', interactive = true }: Props) {
  const instanceId = normalizeAnimationScope(React.useId());
  const wrapper = React.useRef<HTMLDivElement>(null);
  const left = React.useRef<SVGGElement>(null);
  const right = React.useRef<SVGGElement>(null);
  // The field needs concrete theme colours, so a theme change has to re-run this math.
  const themeRevision = React.useSyncExternalStore(subscribeTheme, getThemeRevision, getThemeRevision);
  const art = React.useMemo(() => {
    // Historical face/accessory data is retained on disk, but never selects a body or renders.
    const resolved = identity ?? seedIdentity(seed);
    return getOrCreateMosaicArt(resolved, themeRevision);
  }, [identity, seed, themeRevision]);
  // A two-cell white has only two legal pupil positions. No interpolation off the grid.
  const snapGaze = React.useCallback((x: number): [number, number] =>
    [(x >= 0 ? 1 : 0) - (art.lookRight ? 1 : 0), 0], [art.lookRight]);
  usePupilTracking(wrapper, [left, right], interactive && mood !== 'thinking' && mood !== 'error' && mood !== 'unknown', 1, snapGaze);
  return <div ref={wrapper} className="blob blob-mosaic" data-mood={mood} data-shape={art.name} aria-hidden="true" style={{ width: size, height: size,
    '--mosaic-eye-delay': `${art.eyeDelay}s`, '--mosaic-gaze-step': art.lookRight ? '-1px' : '1px',
  } as React.CSSProperties}>
    <div className="mosaic-step">
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <g data-mosaic-grid transform="translate(8 1) scale(7)" shapeRendering="crispEdges">
          {art.tiles.map(({ x, y, fill }) => <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill={fill} />)}
          {mood === 'thinking' || mood === 'busy' ? <MosaicActivity instanceId={instanceId} mood={mood} cells={art.tiles} seed={art.motionSeed} /> : null}
          {mood === 'thinking' ? <MosaicRainbow instanceId={instanceId} cells={art.tiles} seed={art.motionSeed} /> : null}
          <g className="mosaic-eyes">{(mood === 'error' ? art.errorEyes : art.eyes).map(({ x, y }, index) => <g key={x}>
            <g className="mosaic-eye-open">
              <rect data-mosaic-eye x={x} y={y} width={mood === 'error' ? 3 : 2} height={mood === 'error' ? 3 : 1} fill="#fffdf5" />
              {mood === 'error' ? <g className="mosaic-error-eye" fill="#14111a">
                {[[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]].map(([dx, dy]) =>
                  <rect key={`${dx}:${dy}`} x={x + dx} y={y + dy} width={1} height={1} />)}
              </g>
                : <g ref={index === 0 ? left : right} className="mosaic-pupil"><rect x={x + (art.lookRight ? 1 : 0)} y={y} width={1} height={1} fill="#14111a" /></g>}
            </g>
            <rect className="mosaic-eye-closed" x={x} y={y} width={2} height={1} fill="#14111a" opacity={0} />
          </g>)}</g>
        </g>
      </svg>
    </div>
    <svg className="blob-overlay" viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
      <MoodBadge size={size} mood={mood} inset={mood === 'error' ? -4 : 0} />
    </svg>
  </div>;
}

function sameMosaicIdentity(a?: AvatarIdentity, b?: AvatarIdentity): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.shapeSeed === b.shapeSeed
    && a.shapeName === b.shapeName
    && a.colorSeed === b.colorSeed
    && a.colorIndex === b.colorIndex
    && a.color === b.color
    && a.motionSeed === b.motionSeed;
}

function areMosaicPropsEqual(prev: Props, next: Props): boolean {
  return prev.seed === next.seed
    && (prev.size ?? 30) === (next.size ?? 30)
    && (prev.mood ?? 'idle') === (next.mood ?? 'idle')
    && (prev.interactive ?? true) === (next.interactive ?? true)
    && sameMosaicIdentity(prev.identity, next.identity);
}

const MosaicBlob = React.memo(MosaicBlobImpl, areMosaicPropsEqual);
export default MosaicBlob;
