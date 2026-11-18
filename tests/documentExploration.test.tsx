import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from '../src/components/Markdown';
import {
  clearDocumentExplorationState,
  decodePopoutPointerFromLocation,
  DocumentExplorationProvider,
  enqueueDocumentCandidates,
  invalidateSessionDocuments,
  isHostDocumentResolveSupported,
  lookupCachedDocument,
  parseDocCandidate,
  tokenizeProseDocCandidates,
} from '../src/lib/documentExploration';
import { quoteTextRuns } from '../src/lib/quoteDom';
import type { ChatMessage, Instance, Session } from '../src/types';

const flushMicrotasks = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
};

// Minimal DOM stub mirroring tests/quoteMarkdown.test.ts so React + TreeWalker + quoteTextRuns
// run deterministically in Bun without extra test dependencies.
class StubText {
  nodeType = 3;
  data: string;
  parentNode: StubElement | null = null;
  ownerDocument: StubDocument;
  constructor(value: string, ownerDocument: StubDocument) {
    this.data = value;
    this.ownerDocument = ownerDocument;
  }
  get nodeValue(): string { return this.data; }
  set nodeValue(next: string) { this.data = next; }
  get length(): number { return this.data.length; }
  get parentElement(): StubElement | null { return this.parentNode; }
}

const matchesSimpleSelector = (el: StubElement, selector: string): boolean => {
  const s = selector.trim();
  const attr = /^\[([a-z0-9-]+)\]$/i.exec(s);
  if (attr) return el.hasAttribute(attr[1]!);
  return el.tagName.toLowerCase() === s.toLowerCase();
};

class StubElement {
  nodeType = 1;
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  childNodes: Array<StubElement | StubText> = [];
  parentNode: StubElement | null = null;
  ownerDocument: StubDocument;
  attributes = new Map<string, string>();
  style: Record<string, unknown> = {};
  constructor(tagName: string, ownerDocument: StubDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }
  get parentElement(): StubElement | null { return this.parentNode; }
  get firstChild(): StubElement | StubText | null { return this.childNodes[0] ?? null; }
  get textContent(): string {
    return this.childNodes.map((c) => (c instanceof StubText ? c.data : c.textContent)).join('');
  }
  set textContent(next: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = next ? [new StubText(next, this.ownerDocument)] : [];
    for (const c of this.childNodes) c.parentNode = this;
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
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => matchesSimpleSelector(this, part));
  }
  closest(selector: string): StubElement | null {
    if (this.matches(selector)) return this;
    let cur = this.parentElement;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  contains(other: StubElement | StubText | null): boolean {
    let cur: StubElement | StubText | null = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  querySelectorAll(selector: string): StubElement[] {
    const out: StubElement[] = [];
    const walk = (node: StubElement) => {
      for (const c of node.childNodes) {
        if (c instanceof StubElement) {
          if (c.matches(selector)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): StubElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class StubDocument {
  nodeType = 9;
  documentElement: StubElement;
  defaultView: Record<string, unknown> | null = null;
  constructor() {
    this.documentElement = new StubElement('html', this);
  }
  createElement(tag: string): StubElement { return new StubElement(tag, this); }
  createElementNS(_ns: string, tag: string): StubElement { return new StubElement(tag, this); }
  createTextNode(value: string): StubText { return new StubText(value, this); }
  createTreeWalker(root: StubElement, whatToShow: number) {
    const texts: StubText[] = [];
    const walk = (node: StubElement | StubText) => {
      if (node instanceof StubText) {
        if (whatToShow === 4) texts.push(node);
        return;
      }
      for (const c of node.childNodes) walk(c);
    };
    walk(root);
    let cursor = -1;
    return {
      get currentNode() { return cursor >= 0 ? texts[cursor] : root; },
      nextNode() {
        cursor += 1;
        return cursor < texts.length ? texts[cursor] : null;
      },
    };
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

describe('documentExploration parser, batching, caching & quote compatibility', () => {
  afterEach(() => {
    clearDocumentExplorationState();
  });

  test('parseDocCandidate and tokenizeProseDocCandidates preserve web links and reject unsupported schemes', () => {
    expect(parseDocCandidate('docs/plan.md#phase-2')).toEqual({
      lookupKey: 'docs/plan.md',
      requestPath: 'docs/plan.md',
      fragment: 'phase-2',
      kind: 'markdown',
    });
    expect(parseDocCandidate('./report.html')).toEqual({
      lookupKey: 'report.html',
      requestPath: './report.html',
      kind: 'html',
    });
    expect(parseDocCandidate('https://example.com/guide.html')).toBeNull();
    expect(parseDocCandidate('file:///etc/passwd.md')).toBeNull();
    expect(parseDocCandidate('src/api.ts')).toBeNull();
    expect(parseDocCandidate('#section')).toBeNull();
    expect(parseDocCandidate('cat plan.md')).toBeNull();

    const tokens = tokenizeProseDocCandidates(
      'Compare docs/plan.md and https://example.com/public.html before report.html#summary.'
    );
    expect(tokens.filter((t) => t.type === 'doc').map((t) => t.value)).toEqual([
      'docs/plan.md',
      'report.html#summary',
    ]);
  });

  test('batches & dedupes per host+session, invalidates, caches legacy 404/405/501 silently, and cleans on clear', async () => {
    const scope = globalThis as Record<string, unknown>;
    const prevWindow = scope.window;
    const calls: Array<{ endpointId: string; path: string; body: unknown }> = [];
    let legacy = false;

    scope.window = {
      ember: {
        piRequest: async (endpointId: string, path: string, init?: { body?: unknown }) => {
          calls.push({ endpointId, path, body: init?.body });
          if (legacy) return { ok: false, status: 404, data: { error: 'no route of this host matches' } };
          const cands = ((init?.body as { candidates?: string[] })?.candidates ?? []);
          return {
            ok: true,
            status: 200,
            data: {
              resolved: cands
                .filter((c) => c === 'docs/plan.md' || c.startsWith('batch-'))
                .map((c) => ({
                  candidate: c,
                  resolvedPath: `/proj/${c}`,
                  kind: 'markdown' as const,
                  size: 12,
                  mtimeMs: 1,
                })),
            },
          };
        },
      },
    };

    try {
      enqueueDocumentCandidates('host-a', '10', ['docs/plan.md', 'docs/plan.md', 'missing.md', 'docs/plan.md#sec']);
      await flushMicrotasks();
      expect(calls).toHaveLength(1);
      expect((calls[0]!.body as { candidates: string[] }).candidates).toEqual(['docs/plan.md', 'missing.md']);

      expect(lookupCachedDocument('host-a', '10', 'docs/plan.md#sec')?.resolved.resolvedPath).toBe('/proj/docs/plan.md');
      // Host & session isolation:
      expect(lookupCachedDocument('host-a', '11', 'docs/plan.md')).toBeNull();
      expect(lookupCachedDocument('host-b', '10', 'docs/plan.md')).toBeNull();

      // Re-enqueuing hits cache -> zero extra calls.
      enqueueDocumentCandidates('host-a', '10', ['docs/plan.md']);
      await flushMicrotasks();
      expect(calls).toHaveLength(1);

      // Chunks > 64 candidates into <= 64 batches.
      const large = Array.from({ length: 70 }, (_, idx) => `batch-${idx}.md`);
      enqueueDocumentCandidates('host-a', '10', large);
      await flushMicrotasks();
      expect(calls).toHaveLength(3);
      expect(((calls[1]!.body as { candidates: string[] }).candidates).length).toBe(64);
      expect(((calls[2]!.body as { candidates: string[] }).candidates).length).toBe(6);

      // Invalidation clears session cache so next lookup misses cleanly.
      invalidateSessionDocuments('host-a', '10');
      expect(lookupCachedDocument('host-a', '10', 'docs/plan.md')).toBeNull();

      // Legacy host caching on 404/405/501:
      legacy = true;
      enqueueDocumentCandidates('host-legacy', '1', ['docs/plan.md']);
      await flushMicrotasks();
      expect(isHostDocumentResolveSupported('host-legacy')).toBe(false);
      const countAfterFirst = calls.length;
      enqueueDocumentCandidates('host-legacy', '1', ['other.md']);
      await flushMicrotasks();
      expect(calls).toHaveLength(countAfterFirst);

      // Clear resets unsupported & scope caches.
      clearDocumentExplorationState();
      expect(isHostDocumentResolveSupported('host-legacy')).toBe(true);
    } finally {
      if (prevWindow === undefined) delete scope.window;
      else scope.window = prevWindow;
    }
  });

  test('verified inline code and unverified bare prose links preserve exact quoteMarkdown byte runs', async () => {
    const scope = globalThis as Record<string, unknown>;
    const prevWindow = scope.window;
    const prevDocument = scope.document;
    const prevNodeFilter = scope.NodeFilter;
    const prevAct = scope.IS_REACT_ACT_ENVIRONMENT;

    const doc = new StubDocument();
    const win: Record<string, unknown> = {
      Element: StubElement,
      HTMLIFrameElement: class {},
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      ember: {
        piRequest: async (_endpointId: string, _path: string, init?: { body?: { candidates?: string[] } }) => {
          const cands = init?.body?.candidates ?? [];
          return {
            ok: true,
            status: 200,
            data: {
              resolved: cands
                .filter((c) => c === 'docs/plan.md')
                .map((c) => ({
                  candidate: c,
                  resolvedPath: '/workspace/project/docs/plan.md',
                  kind: 'markdown' as const,
                  size: 100,
                  mtimeMs: 1,
                })),
            },
          };
        },
        openExternal: async () => true,
      },
    };
    doc.defaultView = win;
    scope.window = win;
    scope.document = doc;
    scope.NodeFilter = { SHOW_TEXT: 4 };
    scope.IS_REACT_ACT_ENVIRONMENT = true;

    const source = 'Inspect `docs/plan.md` and missing.md alongside prose.';
    const instance = { id: 'pi:h1', label: 'H1', kind: 'pi', status: 'ready', attachable: true } as Instance;
    const session = { id: '10', instanceId: 'pi:h1', title: 'QA', directory: '/workspace/project', updated: 1 } as Session;
    const messages: ChatMessage[] = [
      { id: 'm1', role: 'assistant', parts: [{ id: 'p1', type: 'text', text: source }] } as unknown as ChatMessage,
    ];

    try {
      const container = doc.createElement('div');
      const root = createRoot(container as unknown as globalThis.Element);

      await React.act(async () => {
        root.render(
          React.createElement(
            DocumentExplorationProvider,
            { instance, session, messages },
            React.createElement(Markdown, { text: source, streaming: false })
          )
        );
      });
      await React.act(async () => {
        await flushMicrotasks();
      });

      const mdRoot = container.firstChild as StubElement;
      const docLinks = mdRoot.querySelectorAll('a');
      // Only verified `docs/plan.md` becomes an <a> inside <code>; unverified missing.md stays plain text!
      expect(docLinks).toHaveLength(1);
      expect(docLinks[0]!.parentElement?.tagName).toBe('CODE');
      expect(docLinks[0]!.textContent).toBe('docs/plan.md');
      // Never renders a <button> inside inline code!
      expect(mdRoot.querySelectorAll('button')).toHaveLength(0);

      // Quote provenance runs remain 100% lossless across verified inline code AND unlinked prose!
      const runs = quoteTextRuns(mdRoot as unknown as globalThis.Element, source);
      expect(runs).not.toBeNull();
      expect(runs!.map((r) => ({ text: r.node.data, slice: source.slice(r.start, r.end) }))).toEqual([
        { text: 'Inspect ', slice: 'Inspect ' },
        { text: 'docs/plan.md', slice: 'docs/plan.md' },
        { text: ' and ', slice: ' and ' },
        { text: 'missing.md', slice: 'missing.md' },
        { text: ' alongside prose.', slice: ' alongside prose.' },
      ]);

      await React.act(async () => {
        root.unmount();
      });
      clearDocumentExplorationState();
    } finally {
      clearDocumentExplorationState();
      if (prevWindow === undefined) delete scope.window;
      else scope.window = prevWindow;
      if (prevDocument === undefined) delete scope.document;
      else scope.document = prevDocument;
      if (prevNodeFilter === undefined) delete scope.NodeFilter;
      else scope.NodeFilter = prevNodeFilter;
      if (prevAct === undefined) delete scope.IS_REACT_ACT_ENVIRONMENT;
      else scope.IS_REACT_ACT_ENVIRONMENT = prevAct;
    }
  });

  test('decodePopoutPointerFromLocation decodes valid metadata-only hashes and rejects malformed ones', () => {
    const ptr = {
      instanceId: 'pi:h1',
      hostLabel: 'Studio Mac',
      sessionId: '42',
      path: '/proj/README.md',
      fragment: 'intro',
    };
    const encoded = encodeURIComponent(btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(ptr)))));
    const parsed = decodePopoutPointerFromLocation({
      search: '?docPopout=1&popoutId=popout_12345678',
      hash: `#ptr=${encoded}`,
    });
    expect(parsed.isPopout).toBe(true);
    expect(parsed.popoutId).toBe('popout_12345678');
    expect(parsed.pointer).toEqual(ptr);

    const bad = decodePopoutPointerFromLocation({
      search: '?docPopout=1&popoutId=popout_12345678',
      hash: '#ptr=%%%not-base64%%%',
    });
    expect(bad.isPopout).toBe(true);
    expect(bad.pointer).toBeNull();
  });
});
