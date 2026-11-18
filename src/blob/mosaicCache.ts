export const MOSAIC_CACHE_LIMIT = 128;

export type LruCache<K, V> = {
  readonly limit: number;
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  get(key: K): V | undefined;
  set(key: K, value: V): V;
  has(key: K): boolean;
  clear(): void;
  keys(): IterableIterator<K>;
};

/** Bounded insertion-ordered Map LRU cache: hits refresh recency; overflow evicts oldest. */
export function createLruCache<K, V>(limit = MOSAIC_CACHE_LIMIT): LruCache<K, V> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('Mosaic LRU cache limit must be a positive integer.');
  }
  const entries = new Map<K, V>();
  let hits = 0;
  let misses = 0;
  return {
    get limit() {
      return limit;
    },
    get size() {
      return entries.size;
    },
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
    get(key: K): V | undefined {
      if (!entries.has(key)) {
        misses++;
        return undefined;
      }
      hits++;
      const value = entries.get(key)!;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key: K, value: V): V {
      if (entries.has(key)) {
        entries.delete(key);
      } else if (entries.size >= limit) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, value);
      return value;
    },
    has(key: K): boolean {
      return entries.has(key);
    },
    clear(): void {
      entries.clear();
      hits = 0;
      misses = 0;
    },
    keys(): IterableIterator<K> {
      return entries.keys();
    },
  };
}

type CellCoords = { x: number; y: number };
type ColoredCell = CellCoords & { fill: string };

const frozenActivitySignatures = new WeakMap<readonly ColoredCell[], string>();
const frozenRainbowSignatures = new WeakMap<readonly CellCoords[], string>();

/** Precompute signatures once for immutable tile arrays built by MosaicBlob. */
export function registerFrozenTiles<T extends ColoredCell>(tiles: readonly T[]): readonly T[] {
  Object.freeze(tiles);
  frozenActivitySignatures.set(tiles, computeActivityCellsSignature(tiles));
  frozenRainbowSignatures.set(tiles, computeRainbowCellsSignature(tiles));
  return tiles;
}

function computeActivityCellsSignature(cells: readonly ColoredCell[]): string {
  let out = '';
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (i > 0) out += '|';
    out += `${cell.x},${cell.y},${cell.fill}`;
  }
  return out;
}

function computeRainbowCellsSignature(cells: readonly CellCoords[]): string {
  let out = '';
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (i > 0) out += '|';
    out += `${cell.x},${cell.y}`;
  }
  return out;
}

export function activityCellsSignature(cells: readonly ColoredCell[]): string {
  return frozenActivitySignatures.get(cells) ?? computeActivityCellsSignature(cells);
}

export function rainbowCellsSignature(cells: readonly CellCoords[]): string {
  return frozenRainbowSignatures.get(cells) ?? computeRainbowCellsSignature(cells);
}

export function normalizeAnimationScope(scope?: string): string {
  return scope ? scope.replace(/[^a-zA-Z0-9]/g, '') : '';
}
