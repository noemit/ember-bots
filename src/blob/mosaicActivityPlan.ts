import { MOSAIC_PROFILES } from './mosaicProfiles';
import { mosaicTrailPlan, type MosaicTrailPlan } from './mosaicTrailPlan';
import { hashString } from './seed';
import {
  MOSAIC_CACHE_LIMIT,
  activityCellsSignature,
  createLruCache,
  normalizeAnimationScope,
} from './mosaicCache';

export type ActivityCell = { x: number; y: number; fill: string; opacity?: number };
export type ActivityEvent = { at: number; until: number; cells: ActivityCell[] };
export type MosaicActivityPlan = { duration: number; delay: number; tracks: ActivityEvent[][]; slots: number };
export type ActivityMood = 'busy' | 'thinking';

export type CachedActivityFrame = {
  readonly track: number;
  readonly slot: number;
  readonly suffix: string;
  readonly frames: string;
};

export type CachedActivitySlot = {
  readonly name: string;
  readonly frames: string;
  readonly style: {
    readonly animationName: string;
    readonly animationDuration: string;
    readonly animationDelay: string;
  };
};

export type CachedActivitySheet = {
  readonly plan: MosaicTrailPlan;
  readonly seedHash: string;
  readonly css: string;
  readonly slots: readonly CachedActivitySlot[];
};

type CachedActivityEntry = {
  plan: MosaicTrailPlan;
  seedHash: string;
  durationCss: string;
  delayCss: string;
  frames?: readonly CachedActivityFrame[];
};

export const MOSAIC_ACTIVITY_CACHE_LIMIT = MOSAIC_CACHE_LIMIT;
export const MOSAIC_ACTIVITY_SHEET_CACHE_LIMIT = MOSAIC_CACHE_LIMIT * 2;

const activityPlanCache = createLruCache<string, CachedActivityEntry>(MOSAIC_ACTIVITY_CACHE_LIMIT);
const activitySheetCache = createLruCache<string, CachedActivitySheet>(MOSAIC_ACTIVITY_SHEET_CACHE_LIMIT);

function activityCacheKey(cellsSig: string, seed: string, mood: ActivityMood): string {
  return `${mood}:${seed.length}:${seed}:${cellsSig}`;
}

function getOrCreateActivityEntry(
  cells: readonly ActivityCell[],
  seed: string,
  mood: ActivityMood,
): { key: string; entry: CachedActivityEntry } {
  const cellsSig = activityCellsSignature(cells);
  const key = activityCacheKey(cellsSig, seed, mood);
  const cached = activityPlanCache.get(key);
  if (cached) return { key, entry: cached };
  const plan = mosaicTrailPlan(cells, seed, MOSAIC_PROFILES[mood]);
  const seedHash = hashString(`mosaic-activity-v1:${mood}:${seed}:${cellsSig}`).toString(36);
  const entry: CachedActivityEntry = {
    plan,
    seedHash,
    durationCss: `${plan.duration}s`,
    delayCss: `${plan.delay}s`,
  };
  activityPlanCache.set(key, entry);
  return { key, entry };
}

/** Both active moods use independent births with full retained lifetimes. */
export function mosaicActivityPlan(
  cells: readonly ActivityCell[],
  seed: string,
  mood: ActivityMood,
): MosaicTrailPlan {
  return getOrCreateActivityEntry(cells, seed, mood).entry.plan;
}

export function activityKeyframes(events: ActivityEvent[], slot: number, duration: number): string {
  const frames = ['0%{opacity:0}', '100%{opacity:0}'];
  for (const event of events) {
    const cell = event.cells[slot];
    if (!cell) continue;
    frames.push(`${(event.at / duration * 100).toFixed(4)}%{opacity:${cell.opacity ?? 1};transform:translate(${cell.x}px,${cell.y}px);fill:${cell.fill}}`);
    frames.push(`${(event.until / duration * 100).toFixed(4)}%{opacity:0}`);
  }
  return frames.join('');
}

function ensureActivityFrames(entry: CachedActivityEntry, mood: ActivityMood): readonly CachedActivityFrame[] {
  if (entry.frames) return entry.frames;
  const { plan } = entry;
  const built: CachedActivityFrame[] = [];
  for (let track = 0; track < plan.tracks.length; track++) {
    const events = plan.tracks[track];
    for (let slot = 0; slot < plan.slots; slot++) {
      built.push({
        track,
        slot,
        suffix: `mosaic-${mood}-${track}-${slot}`,
        frames: activityKeyframes(events, slot, plan.duration),
      });
    }
  }
  entry.frames = built;
  return built;
}

/**
 * Returns the cached trail plan, pre-built `@keyframes` stylesheet, and per-slot style props.
 * Repeated renders or `'busy' <-> 'thinking'` alternations hit both caches in O(1) with zero
 * beat simulation or ~50 KB keyframe string formatting.
 */
export function cachedActivitySheet(
  cells: readonly ActivityCell[],
  seed: string,
  mood: ActivityMood,
  scope?: string,
): CachedActivitySheet {
  const cleanScope = normalizeAnimationScope(scope);
  const { key: planKey, entry } = getOrCreateActivityEntry(cells, seed, mood);
  const sheetKey = `${cleanScope.length}:${cleanScope}:${planKey}`;
  const cachedSheet = activitySheetCache.get(sheetKey);
  if (cachedSheet) return cachedSheet;

  const trackFrames = ensureActivityFrames(entry, mood);
  const prefix = cleanScope ? `m${cleanScope}-${entry.seedHash}` : `m-${entry.seedHash}`;
  const rules: string[] = new Array(trackFrames.length);
  const slots: CachedActivitySlot[] = new Array(trackFrames.length);
  for (let i = 0; i < trackFrames.length; i++) {
    const item = trackFrames[i];
    const name = `${prefix}-${item.suffix}`;
    rules[i] = `@keyframes ${name}{${item.frames}}`;
    slots[i] = {
      name,
      frames: item.frames,
      style: {
        animationName: name,
        animationDuration: entry.durationCss,
        animationDelay: entry.delayCss,
      },
    };
  }
  const sheet: CachedActivitySheet = {
    plan: entry.plan,
    seedHash: entry.seedHash,
    css: rules.join(''),
    slots,
  };
  return activitySheetCache.set(sheetKey, sheet);
}

export function mosaicActivityCacheStats() {
  return {
    plans: {
      size: activityPlanCache.size,
      limit: activityPlanCache.limit,
      hits: activityPlanCache.hits,
      misses: activityPlanCache.misses,
    },
    sheets: {
      size: activitySheetCache.size,
      limit: activitySheetCache.limit,
      hits: activitySheetCache.hits,
      misses: activitySheetCache.misses,
    },
  };
}

export function clearMosaicActivityCaches(): void {
  activityPlanCache.clear();
  activitySheetCache.clear();
}
