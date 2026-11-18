import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from '../src/components/Markdown';
import { quoteTextRuns } from '../src/lib/quoteDom';
import { rehypeQuotePositions } from '../src/lib/quoteMarkdown';
import type { Root, Element } from 'hast';

const text = (value: string, start: number, end: number) => ({ type: 'text' as const, value, position: { start: { line: 1, column: 1, offset: start }, end: { line: 1, column: 1, offset: end } } });
test('parser offsets distinguish repeated words and reject transformed leaves rather than guessing', () => {
  const source = 'same **same** &amp;';
  const tree: Root = { type: 'root', children: [text('same ', 0, 5), { type: 'element', tagName: 'strong', properties: {}, children: [text('same', 7, 11)] }, text(' &', 13, 19)] };
  rehypeQuotePositions()(tree, { value: source });
  expect((tree.children[0] as Element).properties).toEqual({ 'data-quote-start': 0, 'data-quote-end': 5 });
  expect(((tree.children[1] as Element).children[0] as Element).properties).toEqual({ 'data-quote-start': 7, 'data-quote-end': 11 });
  expect((tree.children[2] as Element).properties).toEqual({ 'data-quote-unsupported': true });
});
test('unpositioned code is not mapped and generated paragraph whitespace has no false provenance', () => {
  const code: Element = { type: 'element', tagName: 'code', properties: {}, children: [text('same', 1, 5)] };
  const whitespace = { type: 'text' as const, value: '\n' };
  const tree: Root = { type: 'root', children: [code, whitespace] };
  rehypeQuotePositions()(tree, { value: '`same`' });
  expect(code.children[0].type).toBe('text');
  expect(tree.children[1]).toBe(whitespace);
});

test('inline code uses only its parser-owned exact interior, never normalized content', () => {
  for (const [source, value, supported] of [['`same`', 'same', true], ['``a`b``', 'a`b', true], ['` same `', 'same', false], ['`a\nb`', 'a b', false]] as const) {
    const code: Element = { type: 'element', tagName: 'code', properties: {}, position: text(source, 0, source.length).position, children: [{ type: 'text', value }] };
    const tree: Root = { type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children: [code] }] };
    rehypeQuotePositions()(tree, { value: source });
    if (supported) {
      const leaf = code.children[0] as Element;
      expect(source.slice(Number(leaf.properties['data-quote-start']), Number(leaf.properties['data-quote-end']))).toBe(value);
    } else expect(code.properties['data-quote-unsupported']).toBe(true);
  }
});

class StubText {
  nodeType = 3;
  data: string;
  parentNode: StubElement | null = null;
  ownerDocument: StubDocument;

  constructor(value: string, ownerDocument: StubDocument) {
    this.data = value;
    this.ownerDocument = ownerDocument;
  }

  get nodeValue(): string {
    return this.data;
  }

  set nodeValue(next: string) {
    this.data = next;
  }

  get length(): number {
    return this.data.length;
  }

  get parentElement(): StubElement | null {
    return this.parentNode;
  }
}

const matchesAttrSelector = (element: StubElement, selector: string): boolean => {
  const attr = /^\[([a-z0-9-]+)\]$/i.exec(selector.trim());
  if (attr) return element.hasAttribute(attr[1]);
  return element.tagName.toLowerCase() === selector.trim().toLowerCase();
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

  get parentElement(): StubElement | null {
    return this.parentNode;
  }

  get firstChild(): StubElement | StubText | null {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    return this.childNodes
      .map((child) => (child instanceof StubText ? child.data : child.textContent))
      .join('');
  }

  set textContent(next: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = next ? [new StubText(next, this.ownerDocument)] : [];
    for (const child of this.childNodes) child.parentNode = this;
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

  matches(selector: string): boolean {
    return selector.split(',').some((part) => matchesAttrSelector(this, part));
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
      for (const child of node.childNodes) {
        if (child instanceof StubElement) {
          if (child.matches(selector)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

class StubDocument {
  nodeType = 9;
  documentElement: StubElement;
  defaultView: Record<string, unknown> | null = null;
  treeWalkerCalls = 0;

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

  createTreeWalker(root: StubElement, whatToShow: number) {
    this.treeWalkerCalls += 1;
    const texts: StubText[] = [];
    const walk = (node: StubElement | StubText) => {
      if (node instanceof StubText) {
        if (whatToShow === 4) texts.push(node);
        return;
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    let cursor = -1;
    return {
      get currentNode() {
        return cursor >= 0 ? texts[cursor] : root;
      },
      nextNode() {
        cursor += 1;
        return cursor < texts.length ? texts[cursor] : null;
      },
    };
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

describe('Markdown streaming vs settled quote provenance', () => {
  test('skips rehypeQuotePositions and TreeWalker while streaming, then restores exact quote runs once settled', async () => {
    const scope = globalThis as Record<string, unknown>;
    const prevWindow = scope.window;
    const prevDocument = scope.document;
    const prevNodeFilter = scope.NodeFilter;
    const prevAct = scope.IS_REACT_ACT_ENVIRONMENT;

    const doc = new StubDocument();
    const win: Record<string, unknown> = {
      Element: StubElement,
      HTMLIFrameElement: class {},
      event: undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    doc.defaultView = win;
    scope.window = win;
    scope.document = doc;
    scope.NodeFilter = { SHOW_TEXT: 4 };
    scope.IS_REACT_ACT_ENVIRONMENT = true;

    try {
      const container = doc.createElement('div');
      const root = createRoot(container as unknown as globalThis.Element);

      await React.act(async () => {
        root.render(React.createElement(Markdown, { text: 'Hello **wor', streaming: true }));
      });
      const firstRoot = container.firstChild as StubElement;
      expect(firstRoot.hasAttribute('data-quote-markdown')).toBe(true);
      expect(container.querySelectorAll('[data-quote-start]')).toHaveLength(0);

      // Stream more tokens: no quote-offset spans, same DOM root without detach/re-attach, and zero TreeWalkers.
      await React.act(async () => {
        root.render(React.createElement(Markdown, { text: 'Hello **world**', streaming: true }));
      });
      expect(container.firstChild).toBe(firstRoot);
      expect(container.querySelectorAll('[data-quote-start]')).toHaveLength(0);
      expect(quoteTextRuns(firstRoot as unknown as globalThis.Element, 'Hello **world**')).toBeNull();
      expect(doc.treeWalkerCalls).toBe(0);

      // Settle the message (streaming -> false): full rehypeQuotePositions + quoteTextRuns support returns.
      await React.act(async () => {
        root.render(React.createElement(Markdown, { text: 'Hello **world**', streaming: false }));
      });
      expect(container.firstChild).toBe(firstRoot);
      const quoteSpans = container.querySelectorAll('[data-quote-start]');
      expect(quoteSpans).toHaveLength(2);
      const settledRuns = quoteTextRuns(firstRoot as unknown as globalThis.Element, 'Hello **world**');
      expect(settledRuns?.map((run) => ({ start: run.start, end: run.end, text: run.node.data }))).toEqual([
        { start: 0, end: 6, text: 'Hello ' },
        { start: 8, end: 13, text: 'world' },
      ]);
      expect(doc.treeWalkerCalls).toBe(1);

      await React.act(async () => {
        root.unmount();
      });
    } finally {
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
