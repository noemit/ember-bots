import * as React from 'react';
import { cachedRainbowSheet } from './mosaicRainbowPlan';
import type { ActivityCell } from './mosaicActivityPlan';
import { rainbowCellsSignature } from './mosaicCache';

type Props = {
  cells: readonly ActivityCell[];
  seed: string;
  instanceId?: string;
};

/** A few diagonal groups, not a filter/gradient per pixel. Ink mixes over the unchanged body,
 * below the face. CSS owns the clock and the app's hidden-document pause owns playback. */
function MosaicRainbowImpl({ cells, seed, instanceId }: Props) {
  const fallbackId = React.useId();
  const sheet = cachedRainbowSheet(cells, seed, instanceId ?? fallbackId);
  return <g data-mosaic-rainbow>
    <style>{sheet.css}</style>
    {sheet.plan.bands.map((band, index) => <g key={band.diagonal} className="mosaic-rainbow" fill={band.fill}
      style={sheet.bandStyles[index]}>
      {band.cells.map(cell => <rect key={`${cell.x}:${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} />)}
    </g>)}
  </g>;
}

function areRainbowPropsEqual(prev: Props, next: Props): boolean {
  return prev.seed === next.seed
    && prev.instanceId === next.instanceId
    && (prev.cells === next.cells || rainbowCellsSignature(prev.cells) === rainbowCellsSignature(next.cells));
}

const MosaicRainbow = React.memo(MosaicRainbowImpl, areRainbowPropsEqual);
export default MosaicRainbow;
