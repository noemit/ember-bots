import { hashString, mulberry32 } from './seed';
import { MOSAIC_PROFILES } from './mosaicProfiles';
import {
  MOSAIC_CACHE_LIMIT,
  createLruCache,
  normalizeAnimationScope,
  rainbowCellsSignature,
} from './mosaicCache';

export type RainbowBand = {
  diagonal: number;
  delay: number;
  fill: string;
  cells: { x: number; y: number }[];
};

export type MosaicRainbowPlan = {
  duration: number;
  frames: string;
  bands: RainbowBand[];
};

export type CachedRainbowSheet = {
  readonly plan: MosaicRainbowPlan;
  readonly seedHash: string;
  readonly name: string;
  readonly css: string;
  readonly bandStyles: readonly {
    readonly animationName: string;
    readonly animationDuration: string;
    readonly animationDelay: string;
  }[];
};

type CachedRainbowEntry = {
  plan: MosaicRainbowPlan;
  seedHash: string;
  durationCss: string;
};

export const MOSAIC_RAINBOW_CACHE_LIMIT = MOSAIC_CACHE_LIMIT;
export const MOSAIC_RAINBOW_SHEET_CACHE_LIMIT = MOSAIC_CACHE_LIMIT * 2;

const rainbowPlanCache = createLruCache<string, CachedRainbowEntry>(MOSAIC_RAINBOW_CACHE_LIMIT);
const rainbowSheetCache = createLruCache<string, CachedRainbowSheet>(MOSAIC_RAINBOW_SHEET_CACHE_LIMIT);

function rainbowCacheKey(cellsSig: string, seed: string): string {
  return `${seed.length}:${seed}:${cellsSig}`;
}

function getOrCreateRainbowEntry(
  cells: readonly { x: number; y: number }[],
  seed: string,
): { key: string; entry: CachedRainbowEntry } {
  const cellsSig = rainbowCellsSignature(cells);
  const key = rainbowCacheKey(cellsSig, seed);
  const cached = rainbowPlanCache.get(key);
  if (cached) return { key, entry: cached };

  const profile = MOSAIC_PROFILES.thinking.rainbow;
  const random = mulberry32(hashString(`mosaic-profile-rainbow-v1:${seed}`));
  const duration = profile.cycle.min + random() * (profile.cycle.max - profile.cycle.min);
  const reverse = random() > .5;
  const delay = -mulberry32(hashString(`mosaic-rainbow-phase:${seed}`))() * duration - profile.phase * duration;
  const diagonals = [...new Set(cells.map(cell => cell.x + cell.y))].sort((a, b) => a - b);
  const end = profile.passSeconds / duration * 100;
  const frames = `0%,${end}%,100%{opacity:0}${end * .02}%,${end * .8}%{opacity:${profile.peakOpacity * .4}}${end * .2}%,${end * .6}%{opacity:${profile.peakOpacity}}`;
  const plan: MosaicRainbowPlan = {
    duration,
    frames,
    bands: diagonals.map((diagonal, i) => ({
      diagonal,
      delay: delay + (reverse ? diagonals.length - 1 - i : i) * profile.staggerSeconds,
      fill: `hsl(${Math.round(diagonal / 24 * 300)} 90% 60%)`,
      cells: cells.filter(cell => cell.x + cell.y === diagonal).map(({ x, y }) => ({ x, y })),
    })),
  };
  const entry: CachedRainbowEntry = {
    plan,
    seedHash: hashString(`mosaic-rainbow-v1:${seed}:${cellsSig}`).toString(36),
    durationCss: `${duration}s`,
  };
  rainbowPlanCache.set(key, entry);
  return { key, entry };
}

/** Approved diagonal wash, below the unchanged face. Seeded duration/direction and per-chat
 * phase retain identity; the preview's global phase 0 never synchronizes the whole rail. */
export function mosaicRainbowPlan(cells: readonly { x: number; y: number }[], seed: string): MosaicRainbowPlan {
  return getOrCreateRainbowEntry(cells, seed).entry.plan;
}

export function cachedRainbowSheet(
  cells: readonly { x: number; y: number }[],
  seed: string,
  scope?: string,
): CachedRainbowSheet {
  const cleanScope = normalizeAnimationScope(scope);
  const { key: planKey, entry } = getOrCreateRainbowEntry(cells, seed);
  const sheetKey = `${cleanScope.length}:${cleanScope}:${planKey}`;
  const cachedSheet = rainbowSheetCache.get(sheetKey);
  if (cachedSheet) return cachedSheet;

  const prefix = cleanScope ? `m${cleanScope}-${entry.seedHash}` : `m-${entry.seedHash}`;
  const name = `${prefix}-mosaic-wash`;
  const sheet: CachedRainbowSheet = {
    plan: entry.plan,
    seedHash: entry.seedHash,
    name,
    css: `@keyframes ${name}{${entry.plan.frames}}`,
    bandStyles: entry.plan.bands.map(band => ({
      animationName: name,
      animationDuration: entry.durationCss,
      animationDelay: `${band.delay}s`,
    })),
  };
  return rainbowSheetCache.set(sheetKey, sheet);
}

export function mosaicRainbowCacheStats() {
  return {
    plans: {
      size: rainbowPlanCache.size,
      limit: rainbowPlanCache.limit,
      hits: rainbowPlanCache.hits,
      misses: rainbowPlanCache.misses,
    },
    sheets: {
      size: rainbowSheetCache.size,
      limit: rainbowSheetCache.limit,
      hits: rainbowSheetCache.hits,
      misses: rainbowSheetCache.misses,
    },
  };
}

export function clearMosaicRainbowCaches(): void {
  rainbowPlanCache.clear();
  rainbowSheetCache.clear();
}
