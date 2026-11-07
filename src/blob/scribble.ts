import { hashString, mulberry32 } from './seed';
import type { AvatarIdentity } from '../types';

export const SCRIBBLE_SHAPES = [
  { name: 'starburst', rays: 19, width: 1, height: 0.9, loops: 0.55 },
  { name: 'thistle', rays: 24, width: 0.77, height: 1, loops: 0.2 },
  { name: 'tangle', rays: 16, width: 0.95, height: 0.8, loops: 0.9 },
  { name: 'ruffle', rays: 21, width: 1, height: 0.65, loops: 0.65 },
  { name: 'tuft', rays: 14, width: 0.7, height: 1, loops: 0.7 },
  { name: 'bramble', rays: 26, width: 0.94, height: 0.92, loops: 0.35 },
] as const;

const point = (x: number, y: number) => `${x.toFixed(2)} ${y.toFixed(2)}`;

/** Seeded pen strokes, with no animated filters or per-frame geometry work. */
export function scribbleGeometry(identity: AvatarIdentity) {
  const seed = hashString(`scribble:${identity.shapeSeed}`);
  const shape = SCRIBBLE_SHAPES.find(s => s.name === identity.shapeName) ?? SCRIBBLE_SHAPES[seed % SCRIBBLE_SHAPES.length];
  const rng = mulberry32(seed);
  const at = (angle: number, radius: number) => point(
    50 + Math.cos(angle) * radius * shape.width,
    43 + Math.sin(angle) * radius * shape.height,
  );
  const strokes: { path: string; width: number; shade: boolean }[] = [];
  for (let i = 0; i < shape.rays; i++) {
    const angle = i / shape.rays * Math.PI * 2 + (rng() - 0.5) * 0.24;
    const reach = 27 + rng() * 13;
    const loop = rng() < shape.loops;
    // A loose bundle of pen passes, with thin frayed strands around the heavier stroke.
    for (let strand = 0; strand < 5; strand++) {
      const a = angle + (rng() - 0.5) * 0.2;
      const r = reach - rng() * 4;
      const spread = loop ? 0.12 + rng() * 0.12 : 0.025;
      strokes.push({
        path: `M${at(a - 0.18, 10)} Q${at(a - spread, r * 0.85)} ${at(a - spread * 0.4, r)} Q${at(a + spread, r + 2)} ${at(a + spread, r * 0.75)} L${at(a + 0.13, 10 + rng() * 7)}`,
        width: strand === 0 ? 1.2 + rng() * 1.1 : 0.2 + rng() * 0.65,
        shade: strand === 4,
      });
    }
  }
  const core = Array.from({ length: 20 }, (_, i) => {
    const a = i / 20 * Math.PI * 2;
    return `${i ? 'L' : 'M'}${at(a, 16 + rng() * 4)}`;
  }).join(' ') + 'Z';
  return { name: shape.name, core, strokes, eyeTilt: (rng() - 0.5) * 14, legLean: (rng() - 0.5) * 5 };
}
