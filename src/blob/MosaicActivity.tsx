import * as React from 'react';
import {
  cachedActivitySheet,
  type ActivityCell,
  type ActivityMood,
} from './mosaicActivityPlan';
import { activityCellsSignature } from './mosaicCache';

type Props = {
  cells: readonly ActivityCell[];
  seed: string;
  mood: ActivityMood;
  instanceId?: string;
};

/** Like Lava's generated working motion, these bounded keyframes belong to this mounted SVG.
 * Unique ids isolate identical chat previews; caching plans and frame strings keeps mood
 * flips and remounts O(1) while removing the layer still removes its styles and animations. */
function MosaicActivityImpl({ cells, seed, mood, instanceId }: Props) {
  const fallbackId = React.useId();
  const sheet = cachedActivitySheet(cells, seed, mood, instanceId ?? fallbackId);
  const pixelClass = mood === 'thinking' ? 'mosaic-thought' : 'mosaic-pixel';
  return <g data-mosaic-activity={mood}>
    <style>{sheet.css}</style>
    {sheet.slots.map(({ name, style }) => <rect key={name} className={pixelClass} x={0} y={0} width={1} height={1} opacity={0}
      style={style} />)}
  </g>;
}

function areActivityPropsEqual(prev: Props, next: Props): boolean {
  return prev.mood === next.mood
    && prev.seed === next.seed
    && prev.instanceId === next.instanceId
    && (prev.cells === next.cells || activityCellsSignature(prev.cells) === activityCellsSignature(next.cells));
}

const MosaicActivity = React.memo(MosaicActivityImpl, areActivityPropsEqual);
export default MosaicActivity;
