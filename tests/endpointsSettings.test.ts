import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import EndpointsSettings, {
  canRemoveEndpoint,
  commitEndpoints,
  confirmRemoveEndpoint,
  formatEndpointSaveError,
  initialEndpointLocation,
  type EndpointsSettingsProps,
} from '../src/components/EndpointsSettings';
import type { EmberSettingsPatch, Instance, PiEndpoint } from '../src/types';

const localEndpoint: PiEndpoint = {
  id: 'pi:local',
  label: 'This computer',
  url: 'http://127.0.0.1:3002',
  token: 'local-secret-token',
};

const remoteEndpoint: PiEndpoint = {
  id: 'pi:studio',
  label: 'Studio Mac',
  url: 'http://100.64.0.10:3002',
  token: 'remote-secret-token',
};

const instances: Instance[] = [
  { id: 'pi:local', label: 'This computer', url: localEndpoint.url, kind: 'pi', status: 'ready' },
  { id: 'pi:studio', label: 'Studio Mac', url: remoteEndpoint.url, kind: 'pi', status: 'ready' },
];

function withDesktopBridge<T>(run: () => T): T {
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  scope.window = {
    ember: {
      capabilities: { endpointManagement: true },
      testPiEndpoint: async () => ({ outcome: 'ready', host: 'Studio Mac', message: 'ok' }),
      piRequest: async () => ({ ok: true, status: 200, data: {} }),
    },
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  }
}

const renderSettings = (props: Partial<EndpointsSettingsProps> & Pick<EndpointsSettingsProps, 'endpoints'>) =>
  withDesktopBridge(() =>
    renderToStaticMarkup(
      React.createElement(EndpointsSettings, {
        instances,
        onChange: () => undefined,
        ...props,
      }),
    ),
  );

describe('EndpointsSettings UX safeguards', () => {
  test('hides silent no-op Remove on built-in pi:local while keeping Remove on remote endpoints', () => {
    expect(canRemoveEndpoint(localEndpoint)).toBe(false);
    expect(canRemoveEndpoint(remoteEndpoint)).toBe(true);

    const html = renderSettings({ endpoints: [localEndpoint, remoteEndpoint] });
    expect(html).toContain('Edit This computer');
    expect(html).not.toContain('Remove This computer');
    expect(html).toContain('Remove Studio Mac');

    // Even if removal state points at pi:local, neither confirmation nor deletion can fire.
    const guardedHtml = renderSettings({
      endpoints: [localEndpoint, remoteEndpoint],
      initialRemovingId: 'pi:local',
    });
    expect(guardedHtml).not.toContain('aria-label="Remove This computer"');

    let changed = false;
    const noopResult = confirmRemoveEndpoint([localEndpoint, remoteEndpoint], 'pi:local', () => {
      changed = true;
    });
    expect(noopResult).toEqual({ nextRemoving: null, promise: null });
    expect(changed).toBe(false);
  });

  test('requires inline Confirm remove / Cancel confirmation before deleting a remote endpoint', async () => {
    const idleHtml = renderSettings({ endpoints: [localEndpoint, remoteEndpoint] });
    expect(idleHtml).not.toContain('aria-label="Remove Studio Mac"');
    expect(idleHtml).not.toContain('Confirm remove');

    const confirmingHtml = renderSettings({
      endpoints: [localEndpoint, remoteEndpoint],
      initialRemovingId: 'pi:studio',
    });
    expect(confirmingHtml).toContain('role="group" aria-label="Remove Studio Mac"');
    expect(confirmingHtml).toContain('Confirm remove');
    expect(confirmingHtml).toContain('Cancel');
    expect(confirmingHtml).toContain('Studio Mac');
    expect(confirmingHtml).toContain('Ember');
    expect(confirmingHtml).toContain('conversations stay on that host');
    expect(confirmingHtml).not.toMatch(/HTTP [0-9]|undefined|null|stack|!/);

    const patches: EmberSettingsPatch[] = [];
    let refreshed = 0;
    const confirmed = confirmRemoveEndpoint(
      [localEndpoint, remoteEndpoint],
      'pi:studio',
      (patch) => {
        patches.push(patch);
      },
      () => {
        refreshed += 1;
      },
    );
    expect(confirmed.nextRemoving).toBeNull();
    await confirmed.promise;
    expect(patches).toEqual([{ piEndpoints: [localEndpoint] }]);
    expect(refreshed).toBe(1);
  });

  test('defaults Add computer or container to remote when pi:local is already in endpoints', () => {
    expect(initialEndpointLocation([])).toBe('local');
    expect(initialEndpointLocation([remoteEndpoint])).toBe('local');
    expect(initialEndpointLocation([localEndpoint])).toBe('remote');
    expect(initialEndpointLocation([localEndpoint, remoteEndpoint])).toBe('remote');

    const withLocalHtml = renderSettings({ endpoints: [localEndpoint] });
    expect(withLocalHtml).toMatch(/aria-pressed="true"[^>]*>On another computer or container<\/button>/);
    expect(withLocalHtml).toMatch(/aria-pressed="false"[^>]*>On this computer<\/button>/);
    expect(withLocalHtml).toContain('Computer or container name');
    expect(withLocalHtml).toContain('Kiln URL');
    expect(withLocalHtml).toContain('Bearer token');
    expect(withLocalHtml).not.toContain('Ember includes a local Kiln. No network setup is needed.');

    const withoutLocalHtml = renderSettings({ endpoints: [remoteEndpoint] });
    expect(withoutLocalHtml).toMatch(/aria-pressed="true"[^>]*>On this computer<\/button>/);
    expect(withoutLocalHtml).toContain('Ember includes a local Kiln. No network setup is needed.');
  });

  test('refreshes instances after onChange settles instead of racing a 50ms timer', async () => {
    const code = readFileSync(new URL('../src/components/EndpointsSettings.tsx', import.meta.url), 'utf8');
    expect(code).not.toContain('setTimeout');

    let resolveSave!: () => void;
    const events: string[] = [];
    const pending = commitEndpoints(
      [localEndpoint, remoteEndpoint],
      () =>
        new Promise<void>((resolve) => {
          events.push('save:start');
          resolveSave = () => {
            events.push('save:done');
            resolve();
          };
        }),
      () => {
        events.push('refresh');
      },
    );

    await Promise.resolve();
    expect(events).toEqual(['save:start']);
    resolveSave();
    await pending;
    expect(events).toEqual(['save:start', 'save:done', 'refresh']);

    let refreshedOnFailure = false;
    const failedResult = await commitEndpoints(
      [localEndpoint],
      () => Promise.reject(new Error('disk full')),
      () => {
        refreshedOnFailure = true;
      },
    );
    expect(failedResult).toEqual({ ok: false, error: 'disk full' });
    expect(refreshedOnFailure).toBe(false);

    const okResult = await commitEndpoints([localEndpoint], () => Promise.resolve(), () => {
      refreshedOnFailure = true;
    });
    expect(okResult).toEqual({ ok: true });
    expect(refreshedOnFailure).toBe(true);
  });

  test('renders Test button without trailing space and formats host-named errors per AGENTS copy rules', () => {
    const html = renderSettings({ endpoints: [localEndpoint, remoteEndpoint] });
    expect(html).toContain('>Test</button>');
    expect(html).not.toContain('>Test </button>');

    for (const msg of [
      formatEndpointSaveError('Studio Mac', 'remove', new Error('disk full')),
      formatEndpointSaveError('Studio Mac', 'save', new Error('HTTP 500 undefined null stack!')),
    ]) {
      expect(msg).toContain('Ember');
      expect(msg).toContain('Studio Mac');
      expect(msg).toMatch(/try again|Confirm remove again/i);
      expect(msg).not.toMatch(/!|HTTP \d|\bundefined\b|\bnull\b|\bstack\b|Something went wrong/);
    }
  });

  test('keeps confirmation open and disabled while removing is in flight, surfaces error on failure, and clears stale state on success', async () => {
    const scope = globalThis as Record<string, unknown>;
    const prevWindow = scope.window;
    const prevDoc = scope.document;
    const prevNode = scope.Node;
    const prevElement = scope.Element;
    const prevHTMLElement = scope.HTMLElement;
    const prevAct = scope.IS_REACT_ACT_ENVIRONMENT;

    type Listener = (ev: unknown) => void;
    class DomText {
      nodeType = 3;
      nodeValue: string;
      parentNode: DomEl | null = null;
      ownerDocument: DomDoc;
      constructor(value: string, doc: DomDoc) {
        this.nodeValue = value;
        this.ownerDocument = doc;
      }
      set data(v: string) { this.nodeValue = String(v); }
      get data() { return this.nodeValue; }
      get textContent() { return this.nodeValue; }
      set textContent(v: string) { this.nodeValue = String(v); }
    }
    class DomEl {
      nodeType = 1;
      tagName: string;
      namespaceURI = 'http://www.w3.org/1999/xhtml';
      childNodes: Array<DomEl | DomText> = [];
      parentNode: DomEl | null = null;
      ownerDocument: DomDoc;
      attributes = new Map<string, string>();
      listeners = new Map<string, Set<Listener>>();
      captureListeners = new Map<string, Set<Listener>>();
      style: Record<string, string> = {};
      value = '';
      checked = false;
      constructor(tag: string, doc: DomDoc) {
        this.tagName = tag.toUpperCase();
        this.ownerDocument = doc;
      }
      get disabled(): boolean { return this.attributes.has('disabled'); }
      set disabled(val: boolean) {
        if (val) this.attributes.set('disabled', '');
        else this.attributes.delete('disabled');
      }
      set className(val: string) { this.attributes.set('class', val); }
      get className() { return this.attributes.get('class') ?? ''; }
      get parentElement() { return this.parentNode; }
      get firstChild() { return this.childNodes[0] ?? null; }
      get textContent(): string {
        return this.childNodes.map((c) => c.textContent).join('');
      }
      set textContent(v: string) {
        this.childNodes = v ? [new DomText(String(v), this.ownerDocument)] : [];
        for (const c of this.childNodes) c.parentNode = this;
      }
      appendChild<T extends DomEl | DomText>(child: T): T {
        this.removeChild(child);
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
      }
      removeChild<T extends DomEl | DomText>(child: T): T {
        const idx = this.childNodes.indexOf(child);
        if (idx >= 0) {
          this.childNodes.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      }
      insertBefore<T extends DomEl | DomText>(child: T, before: DomEl | DomText | null): T {
        this.removeChild(child);
        const idx = before ? this.childNodes.indexOf(before) : -1;
        if (idx < 0) this.childNodes.push(child);
        else this.childNodes.splice(idx, 0, child);
        child.parentNode = this;
        return child;
      }
      setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
      removeAttribute(name: string) { this.attributes.delete(name); }
      getAttribute(name: string) { return this.attributes.get(name) ?? null; }
      hasAttribute(name: string) { return this.attributes.has(name); }
      addEventListener(type: string, fn: Listener, capture = false) {
        const map = capture ? this.captureListeners : this.listeners;
        if (!map.has(type)) map.set(type, new Set());
        map.get(type)!.add(fn);
      }
      removeEventListener(type: string, fn: Listener, capture = false) {
        const map = capture ? this.captureListeners : this.listeners;
        map.get(type)?.delete(fn);
      }
      walk(visitor: (el: DomEl) => void) {
        visitor(this);
        for (const c of this.childNodes) {
          if (c instanceof DomEl) c.walk(visitor);
        }
      }
      click() {
        if (this.disabled) return;
        const path: DomEl[] = [this];
        for (let cur = this.parentNode; cur; cur = cur.parentNode) {
          path.push(cur);
        }
        let stopped = false;
        const event = {
          type: 'click',
          target: this,
          currentTarget: this as DomEl,
          bubbles: true,
          cancelable: true,
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() { stopped = true; },
        };
        for (let i = path.length - 1; i >= 0 && !stopped; i--) {
          event.currentTarget = path[i]!;
          for (const fn of [...(path[i]!.captureListeners.get('click') ?? [])]) fn(event);
        }
        for (let i = 0; i < path.length && !stopped; i++) {
          event.currentTarget = path[i]!;
          for (const fn of [...(path[i]!.listeners.get('click') ?? [])]) fn(event);
        }
      }
    }
    class DomDoc {
      nodeType = 9;
      documentElement: DomEl;
      body: DomEl;
      defaultView: Record<string, unknown> | null = null;
      constructor() {
        this.documentElement = new DomEl('html', this);
        this.body = new DomEl('body', this);
        this.documentElement.appendChild(this.body);
      }
      createElement(tag: string) { return new DomEl(tag, this); }
      createElementNS(_ns: string, tag: string) { return new DomEl(tag, this); }
      createTextNode(val: string) { return new DomText(val, this); }
      addEventListener() {}
      removeEventListener() {}
    }

    const doc = new DomDoc();
    let testCalls = 0;
    const win: Record<string, unknown> = {
      Element: DomEl,
      HTMLElement: DomEl,
      HTMLIFrameElement: class {},
      Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
      event: undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      ember: {
        capabilities: { endpointManagement: true },
        testPiEndpoint: async (ep: PiEndpoint) => {
          testCalls += 1;
          return { outcome: 'ready' as const, host: ep.label, message: 'OK' };
        },
      },
    };
    doc.defaultView = win;
    scope.window = win;
    scope.document = doc;
    scope.Node = win.Node;
    scope.Element = DomEl;
    scope.HTMLElement = DomEl;
    scope.IS_REACT_ACT_ENVIRONMENT = true;

    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const findButton = (text: string, rootNode: DomEl = container): DomEl => {
      let found: DomEl | null = null;
      rootNode.walk((el) => {
        if (!found && el.tagName === 'BUTTON' && el.textContent.trim() === text) found = el;
      });
      if (!found) throw new Error(`Button not found: ${text}`);
      return found;
    };
    const findEndpointRow = (id: string): DomEl => {
      let found: DomEl | null = null;
      container.walk((el) => {
        if (!found && el.getAttribute('data-endpoint') === id) found = el;
      });
      if (!found) throw new Error(`Endpoint row not found: ${id}`);
      return found;
    };
    const findRole = (role: string): DomEl | null => {
      let found: DomEl | null = null;
      container.walk((el) => {
        if (!found && el.getAttribute('role') === role) found = el;
      });
      return found;
    };

    try {
      let resolvePending!: () => void;
      let rejectNext = false;
      let commitCount = 0;
      let endpointsState = [localEndpoint, remoteEndpoint];
      let rerender!: () => void;

      const Harness = () => {
        const [tick, setTick] = React.useState(0);
        rerender = () => setTick((n) => n + 1);
        return React.createElement(EndpointsSettings, {
          endpoints: endpointsState,
          instances: endpointsState.map((ep) => ({ id: ep.id, label: ep.label, url: ep.url, kind: 'pi', status: 'ready' })),
          onChange: (patch) => {
            commitCount += 1;
            return new Promise<void>((resolve, reject) => {
              resolvePending = () => {
                if (rejectNext) {
                  reject(new Error('settings file locked'));
                } else {
                  if (patch.piEndpoints) endpointsState = patch.piEndpoints;
                  resolve();
                  rerender();
                }
              };
            });
          },
          'data-tick': tick,
        } as EndpointsSettingsProps);
      };

      await React.act(async () => {
        root.render(React.createElement(Harness));
      });

      // Populate stale test result on Studio Mac first
      await React.act(async () => {
        findButton('Test', findEndpointRow('pi:studio')).click();
        await Promise.resolve();
      });
      expect(testCalls).toBe(1);
      expect(findRole('status')?.textContent).toContain('Studio Mac');

      // Open remove confirmation and submit failing remove
      await React.act(async () => {
        findButton('Remove Studio Mac').click();
      });
      rejectNext = true;
      await React.act(async () => {
        findButton('Confirm remove').click();
      });
      expect(findButton('Removing…').disabled).toBe(true);
      expect(findButton('Cancel').disabled).toBe(true);
      // Duplicate click while in flight is ignored
      await React.act(async () => {
        findButton('Removing…').click();
      });
      expect(commitCount).toBe(1);

      // Fail: confirmation stays open with clear error
      await React.act(async () => {
        resolvePending();
        await Promise.resolve();
      });
      expect(findRole('alert')?.textContent).toContain('Ember');
      expect(findRole('alert')?.textContent).toContain('Studio Mac');
      expect(findButton('Confirm remove').disabled).toBe(false);

      // Retry and succeed: confirmation, error, and stale test result clear
      rejectNext = false;
      await React.act(async () => {
        findButton('Confirm remove').click();
      });
      await React.act(async () => {
        resolvePending();
        await Promise.resolve();
      });
      expect(commitCount).toBe(2);
      expect(findRole('alert')).toBeNull();
      expect(findRole('status')).toBeNull();
      expect(container.textContent).not.toContain('Studio Mac');
    } finally {
      await React.act(async () => {
        root.unmount();
      });
      if (prevWindow === undefined) delete scope.window;
      else scope.window = prevWindow;
      if (prevDoc === undefined) delete scope.document;
      else scope.document = prevDoc;
      if (prevNode === undefined) delete scope.Node;
      else scope.Node = prevNode;
      if (prevElement === undefined) delete scope.Element;
      else scope.Element = prevElement;
      if (prevHTMLElement === undefined) delete scope.HTMLElement;
      else scope.HTMLElement = prevHTMLElement;
      if (prevAct === undefined) delete scope.IS_REACT_ACT_ENVIRONMENT;
      else scope.IS_REACT_ACT_ENVIRONMENT = prevAct;
    }
  });
});
