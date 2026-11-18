import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Transcript from '../src/components/Transcript';
import {
  createReadingGeometryScheduler,
  shouldOfferLastMessageJump as jump,
} from '../src/lib/transcriptReadingGeometry';
import type { ChatMessage, QuoteLink } from '../src/types';

const viewport = { top: 100, bottom: 500 };
describe('last user message navigation geometry', () => {
  test('offers only after the entire latest user message leaves above', () => {
    expect(jump(viewport, { top: 10, bottom: 100 }, [])).toBe(true);
    expect(jump(viewport, { top: 10, bottom: 101 }, [])).toBe(false);
    expect(jump(viewport, { top: 500, bottom: 600 }, [])).toBe(false);
    expect(jump(viewport, undefined, [])).toBe(false);
  });
  test('any partially visible user suppresses it, including a tall row surrounding viewport', () => {
    const latest = { top: -100, bottom: 0 };
    for (const row of [{ top: 99, bottom: 101 }, { top: 499, bottom: 600 }, { top: 0, bottom: 700 }]) {
      expect(jump(viewport, latest, [row])).toBe(false);
    }
    expect(jump(viewport, latest, [{ top: -20, bottom: 100 }, { top: 500, bottom: 600 }])).toBe(true);
  });
  test('works with offset column/modal coordinates and missing virtualized user DOM', () => {
    expect(jump({ top: 350, bottom: 800 }, { top: 200, bottom: 349 }, [])).toBe(true);
    expect(jump({ top: 350, bottom: 350 }, { top: 200, bottom: 349 }, [])).toBe(false);
  });
});

test('crew report cards are not a new human message', async () => {
  const { isHumanReadingMessage } = await import('../src/lib/transcriptReadingGeometry');
  expect(isHumanReadingMessage({ role: 'user', text: 'Please check this.' })).toBe(true);
  expect(isHumanReadingMessage({ role: 'user', text: '[crew] Parse config finished' })).toBe(false);
  expect(isHumanReadingMessage({ role: 'assistant', text: 'Done' })).toBe(false);
});

describe('createReadingGeometryScheduler', () => {
  test('coalesces scroll and resize geometry requests into one rAF measurement and cancels cleanly', () => {
    let nextFrame = 1;
    const frames = new Map<number, () => void>();
    const cancelled: number[] = [];
    let measures = 0;

    const scheduler = createReadingGeometryScheduler(
      () => {
        measures += 1;
      },
      (cb) => {
        const id = nextFrame++;
        frames.set(id, cb);
        return id;
      },
      (id) => {
        cancelled.push(id);
        frames.delete(id);
      },
    );

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(frames.size).toBe(1);
    expect(measures).toBe(0);

    const [frameId, runFrame] = frames.entries().next().value!;
    frames.delete(frameId);
    runFrame();
    expect(measures).toBe(1);

    // A layout flush measures immediately and cancels any pending animation frame.
    scheduler.schedule();
    expect(frames.size).toBe(1);
    scheduler.flush();
    expect(measures).toBe(2);
    expect(frames.size).toBe(0);
    expect(cancelled).toEqual([2]);

    scheduler.schedule();
    scheduler.cancel();
    expect(frames.size).toBe(0);
    expect(cancelled).toEqual([2, 3]);
    expect(measures).toBe(2);
  });
});

class StubText {
  nodeType = 3;
  nodeValue: string;
  parentNode: StubElement | null = null;
  ownerDocument: StubDocument;

  constructor(value: string, ownerDocument: StubDocument) {
    this.nodeValue = value;
    this.ownerDocument = ownerDocument;
  }
}

class StubElement {
  nodeType = 1;
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  childNodes: Array<StubElement | StubText> = [];
  parentNode: StubElement | null = null;
  ownerDocument: StubDocument;
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  style: Record<string, unknown> = {
    setProperty(name: string, value: string) {
      this[name] = value;
    },
    removeProperty(name: string) {
      delete this[name];
    },
  };
  scrollTop = 0;
  scrollHeight = 400;
  clientHeight = 400;

  constructor(tagName: string, ownerDocument: StubDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get parentElement(): StubElement | null {
    return this.parentNode;
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

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  scrollTo(): void {}
  querySelector(): null {
    return null;
  }
  querySelectorAll(): never[] {
    return [];
  }

  getBoundingClientRect() {
    this.ownerDocument.rectReads += 1;
    return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 400, width: 600, height: 400 };
  }
}

class StubDocument {
  nodeType = 9;
  hidden = false;
  activeElement: StubElement | null = null;
  documentElement: StubElement;
  defaultView: Record<string, unknown> | null = null;
  rectReads = 0;

  constructor() {
    this.documentElement = new StubElement('html', this);
  }

  createElement(tag: string): StubElement {
    return new StubElement(tag, this);
  }

  createElementNS(_ns: string, tag: string): StubElement {
    return new StubElement(tag, this);
  }

  createTextNode(value: string): StubText {
    return new StubText(value, this);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

describe('Transcript streaming memoization and reflow avoidance', () => {
  test('settled MessageRows do not re-render and getBoundingClientRect does not run synchronously per streaming token', async () => {
    const scope = globalThis as Record<string, unknown>;
    const prevWindow = scope.window;
    const prevDocument = scope.document;
    const prevResizeObserver = scope.ResizeObserver;
    const prevRaf = scope.requestAnimationFrame;
    const prevCancelRaf = scope.cancelAnimationFrame;
    const prevAct = scope.IS_REACT_ACT_ENVIRONMENT;

    const doc = new StubDocument();
    let nextFrameId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const resizeCallbacks = new Set<() => void>();

    const requestAnimationFrameStub = (cb: FrameRequestCallback): number => {
      const id = nextFrameId++;
      frames.set(id, cb);
      return id;
    };
    const cancelAnimationFrameStub = (id: number): void => {
      frames.delete(id);
    };

    const win: Record<string, unknown> = {
      Element: StubElement,
      HTMLIFrameElement: class {},
      event: undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      requestAnimationFrame: requestAnimationFrameStub,
      cancelAnimationFrame: cancelAnimationFrameStub,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      setInterval: () => 1,
      clearInterval: () => undefined,
      getSelection: () => ({ isCollapsed: true }),
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    };
    doc.defaultView = win;
    scope.window = win;
    scope.document = doc;
    scope.requestAnimationFrame = requestAnimationFrameStub;
    scope.cancelAnimationFrame = cancelAnimationFrameStub;
    scope.ResizeObserver = class {
      private readonly cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe() {
        resizeCallbacks.add(this.cb);
      }
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.cb);
      }
    };
    scope.IS_REACT_ACT_ENVIRONMENT = true;

    try {
      let settledRowDeliveryReads = 0;
      const userMsg: ChatMessage = {
        id: 'e1',
        role: 'user',
        text: 'Explain how streaming works.',
        parts: [{ type: 'text', id: 'e1-0', text: 'Explain how streaming works.' }],
        completed: true,
      };
      const settledAssistant: ChatMessage = {
        id: 'e2',
        role: 'assistant',
        text: 'Here is the diagram.',
        parts: [
          { type: 'text', id: 'e2-0', text: 'Here is the diagram.' },
          {
            type: 'file',
            id: 'e2-img',
            file: { url: 'https://example.com/diagram.png', filename: 'diagram.png', mime: 'image/png' },
          },
        ],
        completed: true,
      };
      Object.defineProperty(settledAssistant, 'delivery', {
        enumerable: true,
        get() {
          settledRowDeliveryReads += 1;
          return undefined;
        },
      });

      const quoteLinks: QuoteLink[] = [
        {
          id: 'ql-1',
          source: {
            sessionKey: 'pi:local::s1',
            quote: 'Explain',
            spans: [{ messageId: 'e1', partId: 'e1-0', start: 0, end: 7, quote: 'Explain', text: userMsg.text }],
          },
          destination: { kind: 'note', sessionKey: 'pi:local::s1', id: 'n1' },
        },
      ];

      const makeLive = (text: string): ChatMessage => ({
        id: 'pi-live',
        role: 'assistant',
        text,
        parts: [{ type: 'text', id: 'pi-live-0', text }],
        completed: false,
        live: true,
        createdAt: 1_000,
      });

      const container = doc.createElement('div');
      const root = createRoot(container as unknown as Element);

      const renderTranscript = async (liveText: string) => {
        await React.act(async () => {
          root.render(
            React.createElement(Transcript, {
              seed: 'pi:local::s1',
              quoteSessionKey: 'pi:local::s1',
              quoteLinks,
              messages: [userMsg, settledAssistant, makeLive(liveText)],
              messagesStatus: 'ready',
              historyComplete: true,
              permissions: [],
              questions: [],
              state: 'busy',
              sending: false,
              sessionTitle: 'Streaming perf',
              instanceLabel: 'Local',
              hideToolCalls: false,
              reasoningDisplay: 'collapsed',
              showQuestions: true,
              expandToolCalls: false,
              toolDisplay: 'collapsed',
              showMessageDetails: false,
              showActivityRail: false,
              compactSpacing: false,
              autoFollow: true,
              onPermission: () => undefined,
              onQuestion: () => undefined,
            })
          );
        });
      };

      await renderTranscript('First');
      const initialRowReads = settledRowDeliveryReads;
      const initialRectReads = doc.rectReads;
      expect(initialRowReads).toBeGreaterThan(0);
      expect(initialRectReads).toBeGreaterThan(0);

      // Clear any opening scroll rAF before streaming tokens.
      frames.clear();

      // Stream three token commits: settled MessageRows stay memoized and zero sync getBoundingClientRect runs!
      await renderTranscript('First second');
      await renderTranscript('First second third');
      await renderTranscript('First second third fourth');

      expect(settledRowDeliveryReads).toBe(initialRowReads);
      expect(doc.rectReads).toBe(initialRectReads);

      // Multiple ResizeObserver notifications coalesce into a single rAF measurement pass.
      for (const cb of resizeCallbacks) cb();
      for (const cb of resizeCallbacks) cb();
      expect(doc.rectReads).toBe(initialRectReads);
      expect(frames.size).toBe(1);

      await React.act(async () => {
        const [, cb] = frames.entries().next().value!;
        frames.clear();
        cb(16);
      });
      expect(doc.rectReads).toBeGreaterThan(initialRectReads);

      await React.act(async () => {
        root.unmount();
      });
    } finally {
      if (prevWindow === undefined) delete scope.window;
      else scope.window = prevWindow;
      if (prevDocument === undefined) delete scope.document;
      else scope.document = prevDocument;
      if (prevResizeObserver === undefined) delete scope.ResizeObserver;
      else scope.ResizeObserver = prevResizeObserver;
      if (prevRaf === undefined) delete scope.requestAnimationFrame;
      else scope.requestAnimationFrame = prevRaf;
      if (prevCancelRaf === undefined) delete scope.cancelAnimationFrame;
      else scope.cancelAnimationFrame = prevCancelRaf;
      if (prevAct === undefined) delete scope.IS_REACT_ACT_ENVIRONMENT;
      else scope.IS_REACT_ACT_ENVIRONMENT = prevAct;
    }
  });
});
