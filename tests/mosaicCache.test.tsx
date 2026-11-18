import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import MosaicBlob from '../src/blob/MosaicBlob';
import MosaicActivity from '../src/blob/MosaicActivity';
import MosaicRainbow from '../src/blob/MosaicRainbow';
import {
  MOSAIC_ACTIVITY_CACHE_LIMIT,
  MOSAIC_ACTIVITY_SHEET_CACHE_LIMIT,
  cachedActivitySheet,
  clearMosaicActivityCaches,
  mosaicActivityCacheStats,
  mosaicActivityPlan,
} from '../src/blob/mosaicActivityPlan';
import {
  MOSAIC_RAINBOW_CACHE_LIMIT,
  MOSAIC_RAINBOW_SHEET_CACHE_LIMIT,
  cachedRainbowSheet,
  clearMosaicRainbowCaches,
  mosaicRainbowCacheStats,
  mosaicRainbowPlan,
} from '../src/blob/mosaicRainbowPlan';
import { MOSAIC_CACHE_LIMIT, createLruCache } from '../src/blob/mosaicCache';
import { mosaicGeometry } from '../src/blob/mosaic';
import { seedIdentity } from '../src/blob/seed';
import type { AvatarIdentity, BallMood } from '../src/types';

class StubElement {
  nodeType = 1;
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  childNodes: Array<StubElement | StubText> = [];
  parentNode: StubElement | null = null;
  ownerDocument: StubDocument;
  style: Record<string, unknown> = {
    setProperty(name: string, value: string) {
      this[name] = value;
    },
    removeProperty(name: string) {
      delete this[name];
    },
  };
  attributes = new Map<string, string>();

  constructor(tagName: string, ownerDocument: StubDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  appendChild<T extends StubElement | StubText>(child: T): T {
    this.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild<T extends StubElement | StubText>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  insertBefore<T extends StubElement | StubText>(child: T, before: StubElement | StubText | null): T {
    this.removeChild(child);
    const idx = before ? this.childNodes.indexOf(before) : -1;
    if (idx < 0) this.childNodes.push(child);
    else this.childNodes.splice(idx, 0, child);
    child.parentNode = this;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  get textContent(): string {
    return this.childNodes
      .map(node => (node.nodeType === 3 ? (node as StubText).nodeValue : (node as StubElement).textContent))
      .join('');
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = value ? [new StubText(value, this.ownerDocument)] : [];
  }

  findAll(predicate: (el: StubElement) => boolean, acc: StubElement[] = []): StubElement[] {
    for (const child of this.childNodes) {
      if (child.nodeType === 1) {
        const el = child as StubElement;
        if (predicate(el)) acc.push(el);
        el.findAll(predicate, acc);
      }
    }
    return acc;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 30, height: 30 };
  }
}

class StubText {
  nodeType = 3;
  nodeValue: string;
  parentNode: StubElement | null = null;
  ownerDocument: StubDocument;

  constructor(text: string, ownerDocument: StubDocument) {
    this.nodeValue = text;
    this.ownerDocument = ownerDocument;
  }
}

class StubDocument {
  nodeType = 9;
  hidden = false;
  activeElement: StubElement | null = null;
  documentElement: StubElement;
  defaultView: Record<string, unknown> | null = null;

  constructor() {
    this.documentElement = new StubElement('html', this);
  }

  createElement(tag: string): StubElement {
    return new StubElement(tag, this);
  }

  createElementNS(_ns: string, tag: string): StubElement {
    return new StubElement(tag, this);
  }

  createTextNode(text: string): StubText {
    return new StubText(text, this);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

const withMinimalDom = async (
  fn: (env: {
    container: StubElement;
    root: ReturnType<typeof createRoot>;
  }) => Promise<void>,
) => {
  const scope = globalThis as Record<string, unknown>;
  const saved = {
    hadWindow: 'window' in scope,
    window: scope.window,
    hadDocument: 'document' in scope,
    document: scope.document,
    hadGetComputedStyle: 'getComputedStyle' in scope,
    getComputedStyle: scope.getComputedStyle,
    hadResizeObserver: 'ResizeObserver' in scope,
    resizeObserver: scope.ResizeObserver,
    hadAct: 'IS_REACT_ACT_ENVIRONMENT' in scope,
    act: scope.IS_REACT_ACT_ENVIRONMENT,
  };

  const doc = new StubDocument();
  const getComputedStyle = () => ({ getPropertyValue: () => '' });
  const win: Record<string, unknown> = {
    Element: StubElement,
    HTMLIFrameElement: class {},
    event: undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getComputedStyle,
  };
  doc.defaultView = win;
  scope.window = win;
  scope.document = doc;
  scope.getComputedStyle = getComputedStyle;
  scope.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  scope.IS_REACT_ACT_ENVIRONMENT = true;

  const container = doc.createElement('div');
  const root = createRoot(container as unknown as Element);

  try {
    await fn({ container, root });
  } finally {
    await React.act(async () => {
      root.unmount();
    });
    if (saved.hadWindow) scope.window = saved.window;
    else delete scope.window;
    if (saved.hadDocument) scope.document = saved.document;
    else delete scope.document;
    if (saved.hadGetComputedStyle) scope.getComputedStyle = saved.getComputedStyle;
    else delete scope.getComputedStyle;
    if (saved.hadResizeObserver) scope.ResizeObserver = saved.resizeObserver;
    else delete scope.ResizeObserver;
    if (saved.hadAct) scope.IS_REACT_ACT_ENVIRONMENT = saved.act;
    else delete scope.IS_REACT_ACT_ENVIRONMENT;
  }
};

describe('Mosaic LRU plan/stylesheet cache and React.memo boundaries', () => {
  test('createLruCache enforces capacity, refreshes recency on hits and rejects invalid limits', () => {
    expect(MOSAIC_CACHE_LIMIT).toBe(128);
    expect(() => createLruCache(0)).toThrow(RangeError);
    expect(() => createLruCache(-4)).toThrow(RangeError);
    expect(() => createLruCache(Number.NaN)).toThrow(RangeError);

    const cache = createLruCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size).toBe(3);

    // Touch 'a' so 'b' becomes the oldest entry.
    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);

    cache.set('d', 4);
    expect(cache.size).toBe(3);
    expect([...cache.keys()]).toEqual(['c', 'a', 'd']);
    expect(cache.has('b')).toBe(false);
  });

  test('MosaicBlob, MosaicActivity and MosaicRainbow are wrapped in React.memo and skip unchanged re-renders', async () => {
    const memoSymbol = Symbol.for('react.memo');
    expect((MosaicBlob as unknown as { $$typeof: symbol }).$$typeof).toBe(memoSymbol);
    expect((MosaicActivity as unknown as { $$typeof: symbol }).$$typeof).toBe(memoSymbol);
    expect((MosaicRainbow as unknown as { $$typeof: symbol }).$$typeof).toBe(memoSymbol);

    clearMosaicActivityCaches();
    clearMosaicRainbowCaches();

    await withMinimalDom(async ({ container, root }) => {
      const baseIdentity: AvatarIdentity = seedIdentity('crew-leader');
      let blobWrapperAttrWrites = 0;

      const Harness = ({
        tick,
        identity,
        mood,
        size,
      }: {
        tick: number;
        identity: AvatarIdentity;
        mood: BallMood;
        size: number;
      }) => (
        <div data-tick={tick}>
          <MosaicBlob seed="crew-leader" identity={identity} mood={mood} size={size} />
        </div>
      );

      await React.act(async () => {
        root.render(<Harness tick={0} identity={baseIdentity} mood="thinking" size={30} />);
      });
      const svg = container.findAll(el => el.tagName === 'SVG')[0]!;
      const origSetAttr = svg.setAttribute.bind(svg);
      svg.setAttribute = (name: string, value: string) => {
        blobWrapperAttrWrites++;
        origSetAttr(name, value);
      };

      expect(mosaicActivityCacheStats().plans.misses).toBe(1);
      expect(mosaicActivityCacheStats().sheets.misses).toBe(1);
      expect(mosaicActivityCacheStats().sheets.hits).toBe(0);
      expect(mosaicRainbowCacheStats().plans.misses).toBe(1);
      expect(mosaicRainbowCacheStats().sheets.misses).toBe(1);
      expect(mosaicRainbowCacheStats().sheets.hits).toBe(0);

      // Unrelated parent updates — including shallow-cloned identity with identical visual traits — bail out at MosaicBlob's React.memo.
      for (let tick = 1; tick <= 8; tick++) {
        await React.act(async () => {
          root.render(
            <Harness
              tick={tick}
              identity={tick % 2 === 0 ? baseIdentity : { ...baseIdentity }}
              mood="thinking"
              size={30}
            />,
          );
        });
      }
      expect(blobWrapperAttrWrites).toBe(0);
      expect(mosaicActivityCacheStats().sheets.hits).toBe(0);
      expect(mosaicRainbowCacheStats().sheets.hits).toBe(0);

      // Resizing updates MosaicBlob's outer SVG box while MosaicActivity and MosaicRainbow bail out via React.memo (0 child renders).
      await React.act(async () => {
        root.render(<Harness tick={9} identity={baseIdentity} mood="thinking" size={55} />);
      });
      expect(svg.getAttribute('width')).toBe('55');
      expect(blobWrapperAttrWrites).toBeGreaterThan(0);
      expect(mosaicActivityCacheStats().plans.misses).toBe(1);
      expect(mosaicActivityCacheStats().sheets.misses).toBe(1);
      expect(mosaicActivityCacheStats().sheets.hits).toBe(0);
      expect(mosaicRainbowCacheStats().plans.misses).toBe(1);
      expect(mosaicRainbowCacheStats().sheets.misses).toBe(1);
      expect(mosaicRainbowCacheStats().sheets.hits).toBe(0);
    });
  });

  test('crew busy <-> thinking alternation and idle remounts hit cached plans and exact @keyframes strings in O(1)', async () => {
    clearMosaicActivityCaches();
    clearMosaicRainbowCaches();

    await withMinimalDom(async ({ container, root }) => {
      const identity = seedIdentity('crew:auth-refactor');

      const readStyles = () => {
        const activityGroup = container.findAll(el => el.getAttribute('data-mosaic-activity') !== null)[0];
        const rainbowGroup = container.findAll(el => el.getAttribute('data-mosaic-rainbow') !== null)[0];
        const activityCss = activityGroup?.findAll(el => el.tagName === 'STYLE')[0]?.textContent ?? null;
        const rainbowCss = rainbowGroup?.findAll(el => el.tagName === 'STYLE')[0]?.textContent ?? null;
        return { activityCss, rainbowCss };
      };

      await React.act(async () => {
        root.render(<MosaicBlob seed="crew:auth-refactor" identity={identity} mood="busy" size={55} />);
      });
      const firstBusy = readStyles();
      expect(firstBusy.activityCss).toContain('@keyframes ');
      expect(firstBusy.rainbowCss).toBeNull();

      await React.act(async () => {
        root.render(<MosaicBlob seed="crew:auth-refactor" identity={identity} mood="thinking" size={55} />);
      });
      const firstThinking = readStyles();
      expect(firstThinking.activityCss).toContain('@keyframes ');
      expect(firstThinking.rainbowCss).toContain('@keyframes ');
      expect(firstThinking.activityCss).not.toBe(firstBusy.activityCss);

      // Both active moods for this chat are now warm: 2 activity misses, 1 rainbow miss.
      expect(mosaicActivityCacheStats().plans.misses).toBe(2);
      expect(mosaicActivityCacheStats().sheets.misses).toBe(2);
      expect(mosaicRainbowCacheStats().plans.misses).toBe(1);
      expect(mosaicRainbowCacheStats().sheets.misses).toBe(1);

      // Alternate 24 times across busy, thinking, and idle (unmounting and remounting both child layers).
      const sequence: BallMood[] = [
        'busy', 'thinking', 'busy', 'thinking', 'idle', 'busy', 'thinking', 'idle',
        'thinking', 'busy', 'thinking', 'busy', 'thinking', 'busy', 'idle', 'thinking',
      ];
      for (const mood of sequence) {
        await React.act(async () => {
          root.render(<MosaicBlob seed="crew:auth-refactor" identity={identity} mood={mood} size={55} />);
        });
        const current = readStyles();
        if (mood === 'busy') {
          expect(current.activityCss).toBe(firstBusy.activityCss);
          expect(current.rainbowCss).toBeNull();
        } else if (mood === 'thinking') {
          expect(current.activityCss).toBe(firstThinking.activityCss);
          expect(current.rainbowCss).toBe(firstThinking.rainbowCss);
        } else {
          expect(current.activityCss).toBeNull();
          expect(current.rainbowCss).toBeNull();
        }
      }

      // Zero additional plan or stylesheet misses across every single alternation and remount.
      const finalActivity = mosaicActivityCacheStats();
      const finalRainbow = mosaicRainbowCacheStats();
      expect(finalActivity.plans.misses).toBe(2);
      expect(finalActivity.sheets.misses).toBe(2);
      expect(finalActivity.sheets.hits).toBeGreaterThanOrEqual(13);
      expect(finalRainbow.plans.misses).toBe(1);
      expect(finalRainbow.sheets.misses).toBe(1);
      expect(finalRainbow.sheets.hits).toBeGreaterThanOrEqual(7);
    });
  });

  test('duplicate previews share cached plans and keyframe bodies while keeping bounded LRU sizes', () => {
    clearMosaicActivityCaches();
    clearMosaicRainbowCaches();

    const cells = mosaicGeometry(seedIdentity('shared')).cells.map(cell => ({ ...cell, fill: '#336699' }));
    const planA = mosaicActivityPlan(cells, 'shared', 'busy');
    const planB = mosaicActivityPlan(cells.map(cell => ({ ...cell })), 'shared', 'busy');
    expect(planB).toBe(planA);

    const sheetRail = cachedActivitySheet(cells, 'shared', 'busy', 'rail0');
    const sheetComposer = cachedActivitySheet(cells, 'shared', 'busy', 'comp1');
    expect(sheetRail.plan).toBe(planA);
    expect(sheetComposer.plan).toBe(planA);
    expect(sheetRail.seedHash).toBe(sheetComposer.seedHash);
    expect(sheetRail.slots[0].frames).toBe(sheetComposer.slots[0].frames);
    expect(sheetRail.slots[0].name).not.toBe(sheetComposer.slots[0].name);
    expect(mosaicActivityCacheStats().plans.misses).toBe(1);

    const rainbowA = mosaicRainbowPlan(cells, 'shared');
    const rainbowB = cachedRainbowSheet(cells, 'shared', 'rail0');
    const rainbowRepeat = cachedRainbowSheet(cells, 'shared', 'rail0');
    expect(rainbowB.plan).toBe(rainbowA);
    expect(rainbowRepeat).toBe(rainbowB);
    expect(mosaicRainbowCacheStats().plans.misses).toBe(1);

    // Overflow past 128 distinct seeds stays strictly bounded in both plan and sheet LRU caches.
    for (let i = 0; i < MOSAIC_ACTIVITY_CACHE_LIMIT + 40; i++) {
      renderToStaticMarkup(<MosaicBlob seed={`overflow-${i}`} mood="thinking" />);
    }
    const activityStats = mosaicActivityCacheStats();
    const rainbowStats = mosaicRainbowCacheStats();
    expect(activityStats.plans.size).toBeLessThanOrEqual(MOSAIC_ACTIVITY_CACHE_LIMIT);
    expect(activityStats.sheets.size).toBeLessThanOrEqual(MOSAIC_ACTIVITY_SHEET_CACHE_LIMIT);
    expect(rainbowStats.plans.size).toBeLessThanOrEqual(MOSAIC_RAINBOW_CACHE_LIMIT);
    expect(rainbowStats.sheets.size).toBeLessThanOrEqual(MOSAIC_RAINBOW_SHEET_CACHE_LIMIT);
  });
});
