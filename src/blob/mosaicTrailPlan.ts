import { hashString, mulberry32 } from './seed';
import { mosaicThinkingCandidates, oppositeThinkingSide, type ThinkingCell } from './mosaicThinkingPlan';
import type { ActivityCell, ActivityEvent, MosaicActivityPlan } from './mosaicActivityPlan';
import type { MosaicProfile } from './mosaicProfiles';

export type TrailBirth = ActivityEvent & { cells: (ThinkingCell & { slot: number })[] };
export type MosaicTrailPlan = MosaicActivityPlan & {
  algorithm: 'independent-trails-v2'; births: TrailBirth[];
  skippedCandidates: number; skippedBudgetCells: number; requestedBirths: number; trailBudget: 64;
};
type Interval = { at: number; until: number };
const time = (value: number) => Math.round(value * 1e6) / 1e6;
/** Circular interval colouring: slots are reused only after expiry, including across the seam.
 * Coordinate reuse is intentional. A slot is not a coordinate and never cuts an older life short. */
export function mosaicTrailPlan(cells: readonly ActivityCell[], seed: string, profile: MosaicProfile): MosaicTrailPlan {
  if (!Number.isFinite(profile.beatMs) || profile.beatMs < 1
    || !Number.isFinite(profile.cycleSeconds) || profile.cycleSeconds < .001
    || !Number.isFinite(profile.appearance.min) || profile.appearance.min < 1
    || profile.appearance.max < profile.appearance.min || !Number.isFinite(profile.appearance.max)
    || profile.cycleSeconds / (profile.appearance.min * profile.beatMs / 1000) > 2000
    || profile.hold.min <= 0 || profile.hold.max < profile.hold.min || !Number.isFinite(profile.hold.max)
    || profile.hold.max * profile.beatMs / 1000 >= profile.cycleSeconds) {
    throw new RangeError('Mosaic trails need finite lifetimes shorter than their cycle and at most 2000 births.');
  }
  const random = mulberry32(hashString(`mosaic-independent-trails-v2:${seed}`));
  const between = (range: { min: number; max: number }) => range.min + random() * (range.max - range.min);
  const pick = <T,>(items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];
  const seconds = profile.beatMs / 1000;
  const skeleton: (Interval & { pair: boolean; touching: boolean })[] = [];
  let at = 0;
  while (at < profile.cycleSeconds) {
    skeleton.push({ at, until: time(at + between(profile.hold) * seconds),
      pair: random() < profile.pairChance, touching: random() < profile.touchChance });
    at = time(at + between(profile.appearance) * seconds);
  }
  const duration = at;
  const overlaps = (a: Interval, b: Interval) => [0, -duration, duration].some(offset =>
    a.at < b.until + offset - 1e-9 && b.at + offset < a.until - 1e-9);
  const candidates = mosaicThinkingCandidates(cells).filter(cell => profile.sides.includes(cell.side))
    .map(cell => ({ ...cell, touchesBody: cells.some(body => Math.abs(body.x - cell.x) + Math.abs(body.y - cell.y) === 1) }));
  const tracks: ActivityEvent[][] = Array.from({ length: profile.constraints.trailBudget }, () => []);
  const births: TrailBirth[] = [];
  let skippedCandidates = 0, skippedBudgetCells = 0;
  for (const event of skeleton) {
    const preferred = candidates.filter(cell => cell.touchesBody === event.touching);
    const origin = pick(preferred);
    if (!origin) { skippedCandidates++; continue; }
    const chosen = [origin];
    if (event.pair) {
      const opposite = preferred.filter(cell => cell.side === oppositeThinkingSide[origin.side]);
      if (opposite.length) chosen.push(pick(opposite)!);
      else skippedCandidates++;
    }
    const born: TrailBirth['cells'] = [];
    for (const cell of chosen) {
      const slot = tracks.findIndex(events => !events.some(other => overlaps(event, other)));
      if (slot < 0) { skippedBudgetCells += chosen.length - born.length; break; }
      const rendered = { ...cell, opacity: between(profile.opacity) };
      tracks[slot].push({ at: event.at, until: event.until, cells: [rendered] });
      born.push({ ...rendered, slot });
    }
    if (born.length) births.push({ at: event.at, until: event.until, cells: born });
  }
  const segments = tracks.filter(events => events.length).map(events => events.flatMap(event =>
    event.until <= duration ? [event] : [
      { ...event, until: duration }, { ...event, at: 0, until: time(event.until - duration) },
    ]).sort((a, b) => a.at - b.at));
  // Separate PRNG: per-chat phase does not perturb the preview's birth sequence.
  const delay = -mulberry32(hashString(`mosaic-trail-phase:${seed}`))() * duration;
  return { algorithm: 'independent-trails-v2', duration, delay, tracks: segments, slots: 1,
    births, skippedCandidates, skippedBudgetCells, requestedBirths: skeleton.length, trailBudget: 64 };
}
