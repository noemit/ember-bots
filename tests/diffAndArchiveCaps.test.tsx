import { describe, expect, test } from 'bun:test';
import { MotionConfig } from 'motion/react';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import ArchiveDialog, { HIDDEN_SESSIONS_INITIAL_CAP } from '../src/components/ArchiveDialog';
import { DIFF_INITIAL_LINE_CAP, DiffView } from '../src/components/Transcript';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { useEmberSettings } from '../src/hooks/useEmberSettings';
import type { EmberSettings, Instance, Session } from '../src/types';

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
    getPropertyValue(name: string) {
      return typeof this[name] === 'string' ? (this[name] as string) : '';
    },
  };
  attributes = new Map<string, string>();

  constructor(tagName: string, ownerDocument: StubDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get parentElement(): StubElement | null {
    return this.parentNode;
  }

  get children(): StubElement[] {
    return this.childNodes.filter((node): node is StubElement => node instanceof StubElement);
  }

  get firstElementChild(): StubElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): StubElement | null {
    return this.children.at(-1) ?? null;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  insertAdjacentElement(position: string, element: StubElement): StubElement | null {
    if (position === 'afterbegin') {
      this.insertBefore(element, this.childNodes[0] ?? null);
      return element;
    }
    if (position === 'beforeend') {
      return this.appendChild(element);
    }
    return element;
  }

  get textContent(): string {
    return this.childNodes.map((child) => (child instanceof StubText ? child.nodeValue : child.textContent)).join('');
  }

  set textContent(value: string) {
    this.childNodes = value ? [new StubText(value, this.ownerDocument)] : [];
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

  contains(other: unknown): boolean {
    let cursor = other as { parentNode?: unknown } | null;
    while (cursor) {
      if (cursor === this) return true;
      cursor = (cursor.parentNode as { parentNode?: unknown } | null) ?? null;
    }
    return false;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  blur(): void {}
  scrollTo(): void {}
  scrollIntoView(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): never[] {
    return [];
  }
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 520, bottom: 600, width: 520, height: 600 };
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
  head: StubElement;
  body: StubElement;
  defaultView: Record<string, unknown> | null = null;

  constructor() {
    this.documentElement = new StubElement('html', this);
    this.head = new StubElement('head', this);
    this.body = new StubElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
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

  createComment(text: string): StubText {
    return new StubText(text, this);
  }

  getElementById(id: string): StubElement | null {
    return findElements(this.documentElement, (el) => el.getAttribute('id') === id)[0] ?? null;
  }

  createTreeWalker() {
    return { nextNode: () => null };
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

const findElements = (root: StubElement, predicate: (el: StubElement) => boolean): StubElement[] => {
  const found: StubElement[] = [];
  const visit = (node: StubElement | StubText) => {
    if (node instanceof StubElement) {
      if (predicate(node)) found.push(node);
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(root);
  return found;
};

const reactPropsOf = (el: StubElement): Record<string, unknown> => {
  const record = el as unknown as Record<string, unknown>;
  const key = Object.keys(record).find((k) => k.startsWith('__reactProps$'));
  if (!key) throw new Error(`Missing React props on <${el.tagName}>`);
  return record[key] as Record<string, unknown>;
};

const withStubDom = async (
  run: (ctx: { doc: StubDocument; container: StubElement; win: Record<string, unknown> }) => Promise<void>
) => {
  const scope = globalThis as Record<string, unknown>;
  const keys = [
    'window',
    'document',
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'SVGElement',
    'Node',
    'NodeFilter',
    'ResizeObserver',
    'MutationObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map<string, { present: boolean; value: unknown }>();
  for (const key of keys) {
    saved.set(key, { present: key in scope, value: scope[key] });
  }

  const doc = new StubDocument();
  const computedStyle = () => ({
    display: 'block',
    visibility: 'visible',
    getPropertyValue: () => '',
  });
  const win: Record<string, unknown> = {
    innerHeight: 900,
    innerWidth: 1280,
    document: doc,
    Element: StubElement,
    HTMLElement: StubElement,
    SVGElement: StubElement,
    HTMLIFrameElement: class {},
    event: undefined,
    location: { search: '', protocol: 'file:' },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    getComputedStyle: computedStyle,
    getSelection: () => ({ isCollapsed: true, rangeCount: 0, removeAllRanges: () => undefined }),
    requestAnimationFrame: (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ember: {},
  };
  doc.defaultView = win;

  scope.window = win;
  scope.document = doc;
  scope.Element = StubElement;
  scope.HTMLElement = StubElement;
  scope.HTMLInputElement = class extends StubElement {};
  scope.SVGElement = StubElement;
  scope.Node = StubElement;
  scope.NodeFilter = { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  scope.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  scope.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  scope.getComputedStyle = computedStyle;
  scope.requestAnimationFrame = win.requestAnimationFrame;
  scope.cancelAnimationFrame = win.cancelAnimationFrame;
  scope.IS_REACT_ACT_ENVIRONMENT = true;

  const container = doc.createElement('div');
  doc.body.appendChild(container);
  try {
    await run({ doc, container, win });
  } finally {
    for (const [key, entry] of saved) {
      if (entry.present) scope[key] = entry.value;
      else delete scope[key];
    }
  }
};

describe('DiffView line cap', () => {
  test('renders <= 300 lines directly and caps larger patches behind "Show all {N} lines"', async () => {
    await withStubDom(async ({ container }) => {
      const root = createRoot(container);
      const shortDiff = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? `+added ${i}` : `-removed ${i}`)).join('\n');
      const hugeDiff = Array.from({ length: 1_250 }, (_, i) => `+line ${i + 1}`).join('\n');
      const nextHugeDiff = Array.from({ length: 640 }, (_, i) => `-line ${i + 1}`).join('\n');

      try {
        await React.act(async () => {
          root.render(<DiffView diff={shortDiff} />);
        });
        expect(findElements(container, (el) => el.tagName === 'SPAN')).toHaveLength(40);
        expect(findElements(container, (el) => el.tagName === 'BUTTON')).toHaveLength(0);

        await React.act(async () => {
          root.render(<DiffView diff={hugeDiff} />);
        });
        expect(findElements(container, (el) => el.tagName === 'SPAN')).toHaveLength(DIFF_INITIAL_LINE_CAP);
        const buttons = findElements(container, (el) => el.tagName === 'BUTTON');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].textContent).toBe('Show all 1250 lines');

        await React.act(async () => {
          (reactPropsOf(buttons[0]).onClick as () => void)();
        });
        expect(findElements(container, (el) => el.tagName === 'SPAN')).toHaveLength(1_250);
        expect(findElements(container, (el) => el.tagName === 'BUTTON')).toHaveLength(0);

        // Replacing `diff` with a different patch resets the cap cleanly.
        await React.act(async () => {
          root.render(<DiffView diff={nextHugeDiff} />);
        });
        expect(findElements(container, (el) => el.tagName === 'SPAN')).toHaveLength(DIFF_INITIAL_LINE_CAP);
        const resetButtons = findElements(container, (el) => el.tagName === 'BUTTON');
        expect(resetButtons).toHaveLength(1);
        expect(resetButtons[0].textContent).toBe('Show all 640 lines');
      } finally {
        await React.act(async () => {
          root.unmount();
        });
      }
    });
  });
});

describe('ArchiveDialog initial row cap', () => {
  test('mounts at most 50 hidden sessions initially, reveals older rows on click, and resets on close', async () => {
    await withStubDom(async ({ doc, container }) => {
      const root = createRoot(container);
      const instances: Instance[] = [
        { id: 'pi:local', label: 'This computer', kind: 'pi', status: 'ready', attachable: true },
      ];
      const makeSessions = (count: number): Session[] =>
        Array.from({ length: count }, (_, index) => ({
          id: `run-${index + 1}`,
          instanceId: 'pi:local',
          title: `Scheduled run ${index + 1}`,
          archived: true,
          updated: (index + 1) * 1_000,
        }));
      const manySessions = makeSessions(135);
      const emptySet = new Set<string>();

      const renderDialog = (open: boolean, sessions: Session[] = manySessions, onOpenChange: (next: boolean) => void = () => {}) => (
        <MotionConfig reducedMotion="always">
          <TooltipProvider>
            <ArchiveDialog
              open={open}
              onOpenChange={onOpenChange}
              sessions={sessions}
              projectsByInstance={{}}
              instances={instances}
              moods={{}}
              previews={{}}
              avatarIdentities={{}}
              blobStyle="buddy"
              instanceDefaults={{}}
              reloadingKeys={emptySet}
              archivingKeys={emptySet}
              onRestoreSession={() => {}}
              onReload={() => {}}
              onArchive={() => {}}
              onCustomizeAppearance={() => {}}
            />
          </TooltipProvider>
        </MotionConfig>
      );

      const mountedRows = () =>
        findElements(doc.body, (el) => el.getAttribute('data-session-key') !== null);
      const showMoreButton = () =>
        findElements(doc.body, (el) => el.tagName === 'BUTTON' && el.textContent.includes('older hidden'))[0];

      try {
        await React.act(async () => {
          root.render(renderDialog(true));
        });
        expect(HIDDEN_SESSIONS_INITIAL_CAP).toBe(50);
        const initialRows = mountedRows();
        expect(initialRows).toHaveLength(HIDDEN_SESSIONS_INITIAL_CAP);
        // Newest session (`run-135`) is mounted first; oldest (`run-1`) is not mounted yet.
        expect(initialRows[0].getAttribute('data-session-key')).toBe('pi:local::run-135');
        expect(initialRows.at(-1)?.getAttribute('data-session-key')).toBe('pi:local::run-86');
        const more = showMoreButton();
        expect(more?.textContent).toBe('Show 85 older hidden sessions');

        await React.act(async () => {
          (reactPropsOf(more!).onClick as () => void)();
        });
        expect(mountedRows()).toHaveLength(135);
        expect(showMoreButton()).toBeUndefined();

        // Closing and reopening resets back to the bounded 50-row initial render.
        await React.act(async () => {
          root.render(renderDialog(false));
        });
        await React.act(async () => {
          root.render(renderDialog(true));
        });
        expect(mountedRows()).toHaveLength(HIDDEN_SESSIONS_INITIAL_CAP);
        expect(showMoreButton()?.textContent).toBe('Show 85 older hidden sessions');

        // Singular copy when exactly 1 older hidden session remains.
        await React.act(async () => {
          root.render(renderDialog(true, makeSessions(51)));
        });
        expect(showMoreButton()?.textContent).toBe('Show 1 older hidden session');
      } finally {
        await React.act(async () => {
          root.unmount();
        });
      }
    });
  });
});

describe('useEmberSettings harness refresh on instance updates', () => {
  test('refreshHarnessSettings adopts settled cold-boot piEndpoints and localHarnessState without extra steady-state renders', async () => {
    await withStubDom(async ({ container, win }) => {
      const root = createRoot(container);
      let backendSettings: Partial<EmberSettings> = {
        piEndpoints: [],
        localHarnessCanRotate: false,
        localHarnessState: { kind: 'disabled', notice: null },
      };
      (win.ember as Record<string, unknown>).getSettings = async () => backendSettings;

      let latest!: ReturnType<typeof useEmberSettings>;
      let renders = 0;
      function HarnessProbe() {
        renders += 1;
        latest = useEmberSettings({ onError: () => {}, onBeforeSave: () => {} });
        return null;
      }

      try {
        await React.act(async () => {
          root.render(<HarnessProbe />);
        });
        await React.act(async () => {
          latest.hydrateSettings(backendSettings);
        });
        expect(latest.settings.piEndpoints).toEqual([]);
        expect(latest.settings.localHarnessCanRotate).toBe(false);

        // Bundled Kiln finishes booting in the background and publishes its endpoint + token state.
        backendSettings = {
          piEndpoints: [{ id: 'pi:local', label: 'This computer', url: 'http://127.0.0.1:3002', token: 'ready-token' }],
          localHarnessCanRotate: true,
          localHarnessState: { kind: 'started', url: 'http://127.0.0.1:3002', version: '1.9.0', notice: null },
          onboardedAt: 1_700_000_000_000,
        };
        await React.act(async () => {
          await latest.refreshHarnessSettings();
        });
        expect(latest.settings.piEndpoints).toHaveLength(1);
        expect(latest.settings.piEndpoints[0]?.id).toBe('pi:local');
        expect(latest.settings.localHarnessCanRotate).toBe(true);
        expect(latest.settings.localHarnessState?.kind).toBe('started');
        expect(latest.settings.onboardedAt).toBe(1_700_000_000_000);

        const rendersAfterSettle = renders;
        const previousSettingsRef = latest.settings;
        await React.act(async () => {
          await latest.refreshHarnessSettings();
        });
        expect(latest.settings).toBe(previousSettingsRef);
        expect(renders).toBe(rendersAfterSettle);
      } finally {
        await React.act(async () => {
          root.unmount();
        });
      }
    });
  });
});
