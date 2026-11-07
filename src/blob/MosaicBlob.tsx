import * as React from 'react';
import { seedIdentity, hashString } from './seed';
import { blobColor } from './color';
import { mosaicGeometry, mosaicTileColor } from './mosaic';
import { MoodBadge, ThinkingArc } from './overlays';
import type { AvatarIdentity, BallMood, BallState } from '../types';
import './blob.css';
import './blob-mosaic.css';

type Props = { seed: string; identity?: AvatarIdentity; size?: number; mood?: BallMood; state?: BallState; interactive?: boolean };

export default function MosaicBlob({ seed, identity, size = 30, mood = 'idle' }: Props) {
  const art = React.useMemo(() => {
    const resolved = identity ?? seedIdentity(seed);
    const base = blobColor('mosaic', resolved);
    const geometry = mosaicGeometry(resolved);
    return { ...geometry, base,
      tiles: geometry.cells.map(cell => ({ ...cell, fill: mosaicTileColor(base, cell.band, cell.y, resolved.colorSeed) })),
      delay: -(hashString(resolved.motionSeed) % 2400) / 1000 };
  }, [identity, seed]);
  return <div className="blob blob-mosaic" data-mood={mood} data-shape={art.name} aria-hidden="true" style={{ width: size, height: size }}>
    <div className="mosaic-step" style={{ animationDelay: `${art.delay}s` }}>
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <g transform="translate(8 1) scale(7)" shapeRendering="crispEdges">
          {art.tiles.map(({ x, y, fill }) => <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill={fill} />)}
          {[3, 6].map(x => <g key={x}>
            <rect x={x} y={art.eyeY} width={2} height={1} fill="#fffdf5" />
            <rect x={x + (art.lookRight ? 1 : 0)} y={art.eyeY} width={1} height={1} fill="#14111a" />
          </g>)}
        </g>
      </svg>
    </div>
    <svg className="blob-overlay" viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
      {mood === 'thinking' ? <ThinkingArc /> : null}
      {mood === 'busy' ? <path d="M36 97h28" stroke={art.base} strokeWidth={4} /> : null}
      <MoodBadge mood={mood} />
    </svg>
  </div>;
}
