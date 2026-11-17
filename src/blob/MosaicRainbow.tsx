import * as React from 'react';
import { mosaicRainbowPlan } from './mosaicRainbowPlan';
import type { ActivityCell } from './mosaicActivityPlan';

/** A few diagonal groups, not a filter/gradient per pixel. Ink mixes over the unchanged body,
 * below the face. CSS owns the clock and the app's hidden-document pause owns playback. */
export default function MosaicRainbow({ cells, seed }: { cells: readonly ActivityCell[]; seed: string }) {
  const plan = React.useMemo(() => mosaicRainbowPlan(cells, seed), [cells, seed]);
  return <g data-mosaic-rainbow>
    {plan.bands.map(band => <g key={band.diagonal} className="mosaic-rainbow" fill={band.fill}
      style={{ animationDuration: `${plan.duration}s`, animationDelay: `${band.delay}s` }}>
      {band.cells.map(cell => <rect key={`${cell.x}:${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} />)}
    </g>)}
  </g>;
}
