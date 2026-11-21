import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentPreviewSurface } from '../src/components/DocumentPreviewDialog';
import Markdown from '../src/components/Markdown';
import { ToolRow } from '../src/components/transcript/ToolBlocks';
import {
  clearDocumentExplorationState,
  decodePopoutPointerFromLocation,
  DocumentExplorationProvider,
  enqueueDocumentCandidates,
  extractCandidatesFromMessages,
  extractToolCallDocPaths,
  getActiveDocumentPreview,
  invalidateSessionDocuments,
  isHostDocumentResolveSupported,
  lookupCachedDocument,
  navigateBackDocumentPreview,
  openDocumentPreview,
  parseDocCandidate,
  parseLineRangeFragment,
  refreshActiveDocumentPreview,
  tokenizeProseDocCandidates,
} from '../src/lib/documentExploration';
import { quoteTextRuns } from '../src/lib/quoteDom';
import type { ChatMessage, Instance, Session, ToolCall } from '../src/types';

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
  const attrEq = /^\[([a-z0-9-]+)="([^"]*)"\]$/i.exec(s);
  if (attrEq) return el.getAttribute(attrEq[1]!) === attrEq[2]!;
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

  test('parseDocCandidate and tokenizeProseDocCandidates handle local file://, %20 spaces, #L ranges and reject unsafe URLs', () => {
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
    expect(parseDocCandidate('docs/My%20Notes.md#L10-L20')).toEqual({
      lookupKey: 'docs/My Notes.md',
      requestPath: 'docs/My Notes.md',
      fragment: 'L10-L20',
      kind: 'markdown',
    });
    expect(parseDocCandidate('file:///workspace/docs/My%20Notes.md#L10-L20')).toEqual({
      lookupKey: '/workspace/docs/My Notes.md',
      requestPath: '/workspace/docs/My Notes.md',
      fragment: 'L10-L20',
      kind: 'markdown',
    });
    expect(parseDocCandidate('file://localhost/workspace/docs/plan.md#phase-2')).toEqual({
      lookupKey: '/workspace/docs/plan.md',
      requestPath: '/workspace/docs/plan.md',
      fragment: 'phase-2',
      kind: 'markdown',
    });

    // Unsafe URLs, foreign hosts, UNC, query strings, traversal, encoded separators & shell text stay null:
    expect(parseDocCandidate('https://example.com/guide.html')).toBeNull();
    expect(parseDocCandidate('file://evil-host/share/plan.md')).toBeNull();
    expect(parseDocCandidate('file://127.0.0.1/workspace/plan.md')).toBeNull();
    expect(parseDocCandidate('file:////server/share/plan.md')).toBeNull();
    expect(parseDocCandidate('file://localhost//server/share/plan.md')).toBeNull();
    expect(parseDocCandidate('file://user:pass@localhost/workspace/plan.md')).toBeNull();
    expect(parseDocCandidate('file:///workspace/docs/../outside/secret.md')).toBeNull();
    expect(parseDocCandidate('file:///workspace/docs/%2e%2e/outside/secret.md')).toBeNull();
    expect(parseDocCandidate('file:///workspace/docs/plan.md?raw=1')).toBeNull();
    expect(parseDocCandidate('file:///workspace/docs/bad%00.md')).toBeNull();
    expect(parseDocCandidate('file:///workspace/docs/bad%2f.md')).toBeNull();
    expect(parseDocCandidate('file:///workspace/docs/bad%5c.md')).toBeNull();
    expect(parseDocCandidate('file:/etc/passwd.md')).toBeNull();
    expect(parseDocCandidate('file:///etc/passwd')).toBeNull();
    expect(parseDocCandidate('//server/share/plan.md')).toBeNull();
    expect(parseDocCandidate('\\\\server\\share\\plan.md')).toBeNull();
    expect(parseDocCandidate('src/api.ts')).toBeNull();
    expect(parseDocCandidate('#section')).toBeNull();
    expect(parseDocCandidate('cat plan.md')).toBeNull();

    expect(parseLineRangeFragment('L10')).toEqual({ startLine: 10, endLine: 10 });
    expect(parseLineRangeFragment('#L10-L20')).toEqual({ startLine: 10, endLine: 20 });
    expect(parseLineRangeFragment('L25-15')).toEqual({ startLine: 15, endLine: 25 });
    expect(parseLineRangeFragment('phase-2')).toBeNull();
    expect(parseLineRangeFragment('L0')).toBeNull();

    const tokens = tokenizeProseDocCandidates(
      'Compare docs/plan.md, file:///workspace/docs/My%20Notes.md#L10-L20, file://evil-host/share/nope.md, and https://example.com/public.html before report.html#summary.'
    );
    expect(tokens.filter((t) => t.type === 'doc').map((t) => t.value)).toEqual([
      'docs/plan.md',
      'file:///workspace/docs/My%20Notes.md#L10-L20',
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

  test('extractToolCallDocPaths and extractCandidatesFromMessages inspect completed file and codemode tools only', () => {
    const mkTool = (overrides: Partial<ToolCall>): ToolCall => ({
      id: 't1',
      tool: 'read',
      status: 'completed',
      ...overrides,
    });

    expect(extractToolCallDocPaths(mkTool({ tool: 'read', input: { path: '@docs/My Notes.md' } }))).toEqual([
      'docs/My Notes.md',
    ]);
    expect(extractToolCallDocPaths(mkTool({ tool: 'write', input: { path: 'docs/out.html' } }))).toEqual([
      'docs/out.html',
    ]);
    expect(extractToolCallDocPaths(mkTool({ tool: 'edit', input: { path: 'README.md' }, status: 'error' }))).toEqual([]);
    expect(extractToolCallDocPaths(mkTool({ tool: 'read', input: { path: 'docs/plan.md' }, status: 'running' }))).toEqual([]);
    expect(extractToolCallDocPaths(mkTool({ tool: 'bash', input: { command: 'cat docs/plan.md' } }))).toEqual([]);
    expect(
      extractToolCallDocPaths(
        mkTool({
          tool: 'codemode',
          nestedCalls: [
            { id: 'c1', name: 'read', args: '{"path":"docs/nested.md"}', status: 'ok' },
            { id: 'c2', name: 'write', args: '{"path":"docs/failed.md"}', status: 'error' },
            { id: 'c3', name: 'bash', args: '{"command":"cat docs/secret.md"}', status: 'ok' },
          ],
        })
      )
    ).toEqual(['docs/nested.md']);

    const msgs: ChatMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        text: '',
        completed: true,
        parts: [
          {
            type: 'text',
            id: 'p1',
            text: 'See [Notes](<docs/My Notes.md>) and [Local](file:///workspace/docs/plan.md#L10).',
          },
          { type: 'tool', id: 'p2', call: mkTool({ tool: 'edit', input: { path: 'docs/edited.md' } }) },
          {
            type: 'tool',
            id: 'p3',
            call: mkTool({
              tool: 'codemode',
              nestedCalls: [{ id: 'c1', name: 'view', args: '{"path":"docs/report.html"}', status: 'ok' }],
            }),
          },
        ],
      },
    ];
    expect(extractCandidatesFromMessages(msgs).sort()).toEqual(
      ['/workspace/docs/plan.md', 'docs/My Notes.md', 'docs/edited.md', 'docs/report.html'].sort()
    );
  });

  test('preview multi-hop Back history and Refresh preserve stack and basePath across failures', async () => {
    const scope = globalThis as Record<string, unknown>;
    const prevWindow = scope.window;
    const readCalls: Array<{ path: string; basePath?: string }> = [];

    scope.window = {
      ember: {
        piRequest: async (_endpointId: string, _url: string, init?: { body?: { path?: string; basePath?: string } }) => {
          const path = init?.body?.path ?? '';
          const basePath = init?.body?.basePath;
          readCalls.push({ path, basePath });
          if (path === 'missing.md') {
            return { ok: false, status: 404, data: { error: 'Kiln could not find missing.md.' } };
          }
          return {
            ok: true,
            status: 200,
            data: {
              path: path.startsWith('/') ? path : `/proj/${path}`,
              kind: 'markdown',
              content: `# ${path}`,
              size: 10,
              mtimeMs: 1,
            },
          };
        },
      },
    };

    try {
      await openDocumentPreview({
        instanceId: 'pi:h1',
        hostLabel: 'Host 1',
        sessionId: '1',
        path: '/proj/a.md',
      });
      await openDocumentPreview({
        instanceId: 'pi:h1',
        hostLabel: 'Host 1',
        sessionId: '1',
        path: 'b.md',
        basePath: '/proj/a.md',
        pushHistory: true,
      });
      await openDocumentPreview({
        instanceId: 'pi:h1',
        hostLabel: 'Host 1',
        sessionId: '1',
        path: 'missing.md',
        basePath: '/proj/b.md',
        pushHistory: true,
      });

      // Refresh while on failed relative link preserves basePath and 2-entry history!
      await refreshActiveDocumentPreview();
      expect(readCalls[readCalls.length - 1]).toEqual({ path: 'missing.md', basePath: '/proj/b.md' });
      const onErrorState = getActiveDocumentPreview();
      expect(onErrorState.open && onErrorState.history.map((h) => h.path)).toEqual(['/proj/a.md', '/proj/b.md']);

      // Back -> b.md still keeps a.md in history!
      await navigateBackDocumentPreview();
      expect(readCalls[readCalls.length - 1]).toEqual({ path: '/proj/b.md', basePath: undefined });
      const afterBack1 = getActiveDocumentPreview();
      expect(afterBack1.open && afterBack1.history.map((h) => h.path)).toEqual(['/proj/a.md']);

      // Back -> a.md works on the second hop too!
      await navigateBackDocumentPreview();
      expect(readCalls[readCalls.length - 1]).toEqual({ path: '/proj/a.md', basePath: undefined });
      const afterBack2 = getActiveDocumentPreview();
      expect(afterBack2.open && afterBack2.history).toEqual([]);
    } finally {
      if (prevWindow === undefined) delete scope.window;
      else scope.window = prevWindow;
    }
  });

  test('pi:tool_execution_update invalidates cache, ToolRow exposes sibling Preview, and DocumentPreviewSurface renders GFM + #L lines', async () => {
    const scope = globalThis as Record<string, unknown>;
    const prevWindow = scope.window;
    const prevDocument = scope.document;
    const prevNodeFilter = scope.NodeFilter;
    const prevAct = scope.IS_REACT_ACT_ENVIRONMENT;

    const doc = new StubDocument();
    let writtenExists = false;
    let eventHandler: ((event: unknown) => void) | null = null;
    const win: Record<string, unknown> = {
      Element: StubElement,
      HTMLIFrameElement: class {},
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      ember: {
        onEvent: (cb: (event: unknown) => void) => {
          eventHandler = cb;
          return () => {
            eventHandler = null;
          };
        },
        piRequest: async (_endpointId: string, url: string, init?: { body?: { candidates?: string[]; path?: string } }) => {
          if (url.endsWith('/documents/read')) {
            return {
              ok: true,
              status: 200,
              data: {
                path: '/workspace/project/docs/created.md',
                kind: 'markdown',
                content: '# Created\nline 2\nline 3\n',
                size: 24,
                mtimeMs: 2,
              },
            };
          }
          const cands = init?.body?.candidates ?? [];
          return {
            ok: true,
            status: 200,
            data: {
              resolved: cands
                .filter((c) => writtenExists && c === 'docs/created.md')
                .map((c) => ({
                  candidate: c,
                  resolvedPath: '/workspace/project/docs/created.md',
                  kind: 'markdown' as const,
                  size: 24,
                  mtimeMs: 2,
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

    const instance = { id: 'pi:h1', label: 'H1', kind: 'pi', status: 'ready', attachable: true } as Instance;
    const session = { id: '10', instanceId: 'pi:h1', title: 'QA', directory: '/workspace/project', updated: 1 } as Session;
    const toolCall: ToolCall = {
      id: 'call-w1',
      tool: 'write',
      status: 'completed',
      title: 'docs/created.md',
      input: { path: 'docs/created.md', content: '# Created\nline 2\nline 3\n' },
      output: 'wrote docs/created.md',
    };
    const messages: ChatMessage[] = [
      { id: 'm1', role: 'assistant', text: '', completed: true, parts: [{ type: 'tool', id: 'p1', call: toolCall }] },
    ];

    try {
      const container = doc.createElement('div');
      const root = createRoot(container as unknown as globalThis.Element);

      await React.act(async () => {
        root.render(
          React.createElement(
            DocumentExplorationProvider,
            { instance, session, messages },
            React.createElement(ToolRow, { call: toolCall })
          )
        );
      });
      await React.act(async () => {
        await flushMicrotasks();
      });

      // Before file exists on disk: negative-cached -> zero Preview buttons!
      expect(container.querySelectorAll('[data-doc-preview-trigger="true"]')).toHaveLength(0);

      // Simulate bot writing the file & Kiln emitting pi:tool_execution_update:
      writtenExists = true;
      await React.act(async () => {
        eventHandler?.({ instanceId: 'pi:h1', type: 'pi:tool_execution_update', sessionId: '10' });
        await flushMicrotasks();
      });

      const triggers = container.querySelectorAll('[data-doc-preview-trigger="true"]');
      expect(triggers).toHaveLength(1);
      // Preview button is a sibling of the expand button, never nested inside it!
      expect(triggers[0]!.closest('button')).toBe(triggers[0]!);
      expect(triggers[0]!.parentElement?.querySelectorAll('button')).toHaveLength(2);

      // Surface renders #L2-L3 in Source view with highlighted lines AND Rendered GFM task lists/tables/Copy code:
      const docFixture = {
        path: '/workspace/project/docs/created.md',
        kind: 'markdown' as const,
        content: '# Created\nline 2\nline 3\n\n- [x] Done\n\n| Col |\n| --- |\n| Val |\n\n```ts\nconst x = 1;\n```\n',
        size: 80,
        mtimeMs: 2,
      };
      const sourceMarkup = renderToStaticMarkup(
        React.createElement(DocumentPreviewSurface, {
          hostLabel: 'H1',
          path: docFixture.path,
          loading: false,
          document: docFixture,
          error: null,
          fragment: 'L2-L3',
          onRefresh: () => undefined,
          onOpenRelativeDoc: () => undefined,
        })
      );
      expect(sourceMarkup).toContain('data-testid="document-preview-source"');
      expect(sourceMarkup).toContain('data-line="2" data-line-highlighted="true"');
      expect(sourceMarkup).toContain('data-line="3" data-line-highlighted="true"');
      expect(sourceMarkup).not.toContain('data-line="1" data-line-highlighted="true"');

      const renderedMarkup = renderToStaticMarkup(
        React.createElement(DocumentPreviewSurface, {
          hostLabel: 'H1',
          path: docFixture.path,
          loading: false,
          document: docFixture,
          error: null,
          onRefresh: () => undefined,
          onOpenRelativeDoc: () => undefined,
        })
      );
      expect(renderedMarkup).toContain('aria-label="Copy code"');
      expect(renderedMarkup).toContain('contains-task-list');
      expect(renderedMarkup).toContain('<table>');

      await React.act(async () => {
        root.unmount();
      });
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
});
