import * as React from 'react';
import { createRoot } from 'react-dom/client';

class MockNode {
  nodeType: number;
  tagName: string;
  children: MockNode[] = [];
  parentNode: MockNode | null = null;
  attributes = new Map<string, string>();
  style: Record<string, unknown> = {};
  data = '';
  ownerDocument: unknown;
  namespaceURI = 'http://www.w3.org/1999/xhtml';

  constructor(nodeType: number, tagName = '', ownerDocument?: unknown) {
    this.nodeType = nodeType;
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
  }

  set textContent(value: string) {
    this.data = String(value);
    this.children = [];
  }

  get textContent(): string {
    if (this.nodeType === 8) return '';
    return this.children.length
      ? this.children.map((child) => child.textContent).join('')
      : this.data;
  }

  set nodeValue(value: string) {
    this.data = String(value);
  }

  get nodeValue(): string {
    return this.data;
  }

  appendChild(child: MockNode) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: MockNode) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  insertBefore(child: MockNode, before: MockNode | null) {
    child.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    return child;
  }

  setAttribute(key: string, value: string) {
    this.attributes.set(key, String(value));
  }

  removeAttribute(key: string) {
    this.attributes.delete(key);
  }

  addEventListener() {}
  removeEventListener() {}
}

export const withTestRoot = async <T>(
  fn: (helpers: {
    render: (element: React.ReactNode) => Promise<void>;
    act: (callback: () => void | Promise<void>) => Promise<void>;
    text: () => string;
    window: Record<string, unknown>;
  }) => Promise<T>
): Promise<T> => {
  const globals = globalThis as Record<string, unknown>;
  const hadWindow = 'window' in globals;
  const previousWindow = globals.window;
  const hadDocument = 'document' in globals;
  const previousDocument = globals.document;
  const hadActEnv = 'IS_REACT_ACT_ENVIRONMENT' in globals;
  const previousActEnv = globals.IS_REACT_ACT_ENVIRONMENT;

  const doc: Record<string, unknown> = {
    nodeType: 9,
    activeElement: null,
    createElement(tag: string) {
      return new MockNode(1, tag.toUpperCase(), doc);
    },
    createElementNS(_ns: string, tag: string) {
      return new MockNode(1, tag.toUpperCase(), doc);
    },
    createTextNode(text: string) {
      const node = new MockNode(3, '#text', doc);
      node.data = text;
      return node;
    },
    createComment(text: string) {
      const node = new MockNode(8, '#comment', doc);
      node.data = text;
      return node;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.documentElement = new MockNode(1, 'HTML', doc);
  doc.body = new MockNode(1, 'BODY', doc);

  const win: Record<string, unknown> = {
    ...(previousWindow && typeof previousWindow === 'object' ? (previousWindow as Record<string, unknown>) : {}),
    event: undefined,
    document: doc,
    HTMLIFrameElement: class {},
    navigator: { userAgent: '' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener() {},
    removeEventListener() {},
  };
  doc.defaultView = win;

  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.window = win;
  globals.document = doc;

  const container = new MockNode(1, 'DIV', doc);
  const root = createRoot(container as unknown as Element);

  try {
    return await fn({
      render: async (element) => {
        await React.act(async () => {
          root.render(element);
        });
      },
      act: async (callback) => {
        await React.act(async () => {
          await callback();
        });
      },
      text: () => container.textContent,
      window: win,
    });
  } finally {
    await React.act(async () => {
      root.unmount();
    });
    if (hadWindow) globals.window = previousWindow;
    else delete globals.window;
    if (hadDocument) globals.document = previousDocument;
    else delete globals.document;
    if (hadActEnv) globals.IS_REACT_ACT_ENVIRONMENT = previousActEnv;
    else delete globals.IS_REACT_ACT_ENVIRONMENT;
  }
};
