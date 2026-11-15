import * as React from 'react';
import { activityKeyframes, mosaicActivityPlan, type ActivityCell } from './mosaicActivityPlan';

type Props = { cells: ActivityCell[]; seed: string; mood: 'busy' | 'thinking' };

/** Like Lava's generated working motion, these bounded keyframes belong to this mounted SVG.
 * Unique ids isolate identical chat previews; removing the layer removes its styles and animations. */
export default function MosaicActivity({ cells, seed, mood }: Props) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const plan = React.useMemo(() => mosaicActivityPlan(cells, seed, mood), [cells, seed, mood]);
  const slots = plan.tracks.flatMap((events, track) => Array.from({ length: 3 }, (_, slot) => ({
    name: `${uid}-mosaic-${track}-${slot}`, frames: activityKeyframes(events, slot, plan.duration),
  })));
  return <g data-mosaic-activity={mood}>
    <style>{slots.map(({ name, frames }) => `@keyframes ${name}{${frames}}`).join('')}</style>
    {slots.map(({ name }) => <rect key={name} className={mood === 'thinking' ? 'mosaic-thought' : 'mosaic-pixel'} x={0} y={0} width={1} height={1} opacity={0}
      style={{ animationName: name, animationDuration: `${plan.duration}s`, animationDelay: `${plan.delay}s` }} />)}
  </g>;
}
