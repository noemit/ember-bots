import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import CustomProviders, { formatCustomProviderError } from '../src/components/CustomProviders';
import ProvidersSettings, {
  formatEnvFallbackNotice,
  formatProviderActionError,
} from '../src/components/ProvidersSettings';
import type { Instance, PiEndpoint } from '../src/types';

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
  private _value = '';
  checked = false;
  get value(): string { return this._value; }
  set value(v: string) { this._value = String(v); }
  constructor(tag: string, doc: DomDoc) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
  }
  get disabled(): boolean { return this.attributes.has('disabled'); }
  set disabled(val: boolean) {
    if (val) this.attributes.set('disabled', '');
    else this.attributes.delete('disabled');
  }
  get options(): DomEl[] {
    return this.childNodes.filter((c): c is DomEl => c instanceof DomEl && c.tagName === 'OPTION');
  }
  get length(): number {
    return this.tagName === 'SELECT' ? this.options.length : 0;
  }
  private syncSelectOptions() {
    if (this.tagName !== 'SELECT') return;
    const opts = this.options;
    const self = this as unknown as Record<number, DomEl | undefined>;
    for (let i = 0; i < opts.length; i++) self[i] = opts[i];
    for (let i = opts.length; i in self; i++) delete self[i];
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
    if (child.parentNode) child.parentNode.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    this.syncSelectOptions();
    return child;
  }
  removeChild<T extends DomEl | DomText>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    this.syncSelectOptions();
    return child;
  }
  insertBefore<T extends DomEl | DomText>(child: T, before: DomEl | DomText | null): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    const idx = before ? this.childNodes.indexOf(before) : -1;
    if (idx < 0) this.childNodes.push(child);
    else this.childNodes.splice(idx, 0, child);
    child.parentNode = this;
    this.syncSelectOptions();
    return child;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  focus() {}
  scrollIntoView() {}
  closest(selector: string): DomEl | null {
    const targetTag = selector.trim().toUpperCase();
    if (this.tagName === targetTag) return this;
    for (let cur = this.parentNode; cur; cur = cur.parentNode) {
      if (cur.tagName === targetTag) return cur;
    }
    return null;
  }
  contains(other: DomEl | DomText | null): boolean {
    let cur: DomEl | DomText | null = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
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
  dispatchSimple(type: string) {
    const path: DomEl[] = [this];
    for (let cur = this.parentNode; cur; cur = cur.parentNode) {
      path.push(cur);
    }
    let stopped = false;
    const event = {
      type,
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
      for (const fn of [...(path[i]!.captureListeners.get(type) ?? [])]) fn(event);
    }
    for (let i = 0; i < path.length && !stopped; i++) {
      event.currentTarget = path[i]!;
      for (const fn of [...(path[i]!.listeners.get(type) ?? [])]) fn(event);
    }
  }
  click() {
    if (this.disabled) return;
    this.dispatchSimple('click');
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
  getElementById(id: string): DomEl | null {
    let found: DomEl | null = null;
    this.documentElement.walk((el) => {
      if (!found && el.getAttribute('id') === id) found = el;
    });
    return found;
  }
  addEventListener() {}
  removeEventListener() {}
}

class DomSelectEl extends DomEl {
  get value(): string { return super.value; }
  set value(v: string) { super.value = v; }
}
class DomFormEl extends DomEl {}

type ProviderState = {
  id: string;
  name: string;
  credential: 'api_key' | 'oauth' | null;
  envVar?: string;
  custom?: boolean;
  signIn: null | { label: string; pending: boolean };
};

const flushMicrotasks = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const setupDom = (
  piRequest: (endpointId: string, path: string, init?: { method?: string; body?: unknown }) => Promise<{
    ok: boolean;
    status: number;
    data?: unknown;
  }>,
) => {
  const scope = globalThis as Record<string, unknown>;
  const saved = {
    window: scope.window,
    document: scope.document,
    Node: scope.Node,
    Element: scope.Element,
    HTMLElement: scope.HTMLElement,
    HTMLInputElement: scope.HTMLInputElement,
    HTMLSelectElement: scope.HTMLSelectElement,
    HTMLFormElement: scope.HTMLFormElement,
    act: scope.IS_REACT_ACT_ENVIRONMENT,
  };
  const doc = new DomDoc();
  const win: Record<string, unknown> = {
    Element: DomEl,
    HTMLElement: DomEl,
    HTMLInputElement: DomEl,
    HTMLSelectElement: DomSelectEl,
    HTMLFormElement: DomFormEl,
    HTMLIFrameElement: class {},
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    event: undefined,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    ember: { piRequest },
  };
  doc.defaultView = win;
  scope.window = win;
  scope.document = doc;
  scope.Node = win.Node;
  scope.Element = DomEl;
  scope.HTMLElement = DomEl;
  scope.HTMLInputElement = DomEl;
  scope.HTMLSelectElement = DomSelectEl;
  scope.HTMLFormElement = DomFormEl;
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  const restore = async () => {
    await React.act(async () => {
      root.unmount();
    });
    if (saved.window === undefined) delete scope.window;
    else scope.window = saved.window;
    if (saved.document === undefined) delete scope.document;
    else scope.document = saved.document;
    if (saved.Node === undefined) delete scope.Node;
    else scope.Node = saved.Node;
    if (saved.Element === undefined) delete scope.Element;
    else scope.Element = saved.Element;
    if (saved.HTMLElement === undefined) delete scope.HTMLElement;
    else scope.HTMLElement = saved.HTMLElement;
    if (saved.HTMLInputElement === undefined) delete scope.HTMLInputElement;
    else scope.HTMLInputElement = saved.HTMLInputElement;
    if (saved.HTMLSelectElement === undefined) delete scope.HTMLSelectElement;
    else scope.HTMLSelectElement = saved.HTMLSelectElement;
    if (saved.HTMLFormElement === undefined) delete scope.HTMLFormElement;
    else scope.HTMLFormElement = saved.HTMLFormElement;
    if (saved.act === undefined) delete scope.IS_REACT_ACT_ENVIRONMENT;
    else scope.IS_REACT_ACT_ENVIRONMENT = saved.act;
  };

  return { container, root, restore };
};

const findByAriaLabel = (root: DomEl, label: string, role?: string): DomEl | null => {
  let found: DomEl | null = null;
  root.walk((el) => {
    if (!found && el.getAttribute('aria-label') === label && (!role || el.getAttribute('role') === role)) {
      found = el;
    }
  });
  return found;
};

const findButtonByText = (root: DomEl, text: string): DomEl | null => {
  let found: DomEl | null = null;
  root.walk((el) => {
    if (!found && el.tagName === 'BUTTON' && el.textContent.trim() === text) found = el;
  });
  return found;
};

const findAllRoles = (root: DomEl, role: string): DomEl[] => {
  const out: DomEl[] = [];
  root.walk((el) => {
    if (el.getAttribute('role') === role) out.push(el);
  });
  return out;
};

const endpoint: PiEndpoint = {
  id: 'pi:studio',
  label: 'Studio Mac',
  url: 'http://studio:4096',
  token: 'tok',
};

const instance: Instance = {
  id: 'pi:studio',
  label: 'Studio Mac',
  url: 'http://studio:4096',
  kind: 'pi',
  status: 'ready',
};

describe('ProvidersSettings copy and credential removal UX', () => {
  test('error and env-fallback notices name the host and provider with recovery guidance and no jargon', () => {
    const messages = [
      formatProviderActionError('Studio Mac', 'DeepInfra', 'remove', new Error('HTTP 500 undefined null stack!')),
      formatProviderActionError('Studio Mac', 'DeepInfra', 'save', new Error('connection refused')),
      formatEnvFallbackNotice('Studio Mac', 'OpenAI', 'OPENAI_API_KEY'),
      formatCustomProviderError('Studio Mac', 'remove Local vLLM', new Error('HTTP 400 stack!')),
    ];
    for (const msg of messages) {
      expect(msg).toContain('Studio Mac');
      expect(msg).not.toMatch(/!|HTTP \d|\bundefined\b|\bnull\b|\bstack\b|Something went wrong/);
    }
    expect(messages[0]).toContain('DeepInfra');
    expect(messages[0]).toMatch(/Remove credential again/);
    expect(messages[2]).toContain('OPENAI_API_KEY');
    expect(messages[2]).toMatch(/unset/i);
    expect(messages[2]).toMatch(/restart Kiln/i);
    expect(messages[3]).toContain('Local vLLM');
  });

  test('inventory mode removes saved credentials without Manage, locks confirmation while in flight, keeps confirmation on failure, and clears managing/confirmation/drafts on success', async () => {
    const state: ProviderState[] = [
      { id: 'deepinfra', name: 'DeepInfra', credential: 'api_key', signIn: null },
      { id: 'openai', name: 'OpenAI', credential: null, envVar: 'OPENAI_API_KEY', signIn: null },
    ];
    let resolveDelete!: (res: { ok: boolean; status: number; data?: unknown }) => void;
    let deleteAttempts = 0;
    const notifyCalls: Array<{ id: string; options?: unknown }> = [];

    const { container, root, restore } = setupDom(async (_endpointId, path, init) => {
      if (path === '/providers' && (!init?.method || init.method === 'GET')) {
        return { ok: true, status: 200, data: { providers: state.map((p) => ({ ...p })), default: null } };
      }
      if (path === '/providers/deepinfra' && init?.method === 'POST') {
        state[0]!.credential = 'api_key';
        return { ok: true, status: 200, data: { ok: true, provider: 'deepinfra', credential: 'api_key' } };
      }
      if (path === '/providers/deepinfra' && init?.method === 'DELETE') {
        deleteAttempts += 1;
        return await new Promise((resolve) => {
          resolveDelete = resolve;
        });
      }
      if (path === '/models/refresh' && init?.method === 'POST') {
        return { ok: true, status: 200, data: { models: [], default: null } };
      }
      if (path === '/custom-providers') {
        return { ok: true, status: 200, data: { providers: [] } };
      }
      if (path === '/local-runtimes/ollama') {
        return {
          ok: true,
          status: 200,
          data: {
            baseUrl: 'http://127.0.0.1:11434',
            defaultBaseUrl: 'http://127.0.0.1:11434',
            customAddress: false,
            running: false,
            hasModels: false,
            models: [],
          },
        };
      }
      return { ok: false, status: 404, data: { error: 'not found' } };
    });

    try {
      await React.act(async () => {
        root.render(
          <ProvidersSettings
            inventory
            endpoints={[endpoint]}
            instances={[instance]}
            onDefaultChange={() => undefined}
            onProviderChange={(id, options) => {
              notifyCalls.push({ id, options });
            }}
          />,
        );
        await flushMicrotasks();
      });

      // Trash button is directly exposed on DeepInfra without opening Manage, while env-only OpenAI has none.
      expect(Boolean(findByAriaLabel(container, 'Remove credential for DeepInfra'))).toBe(true);
      expect(Boolean(findByAriaLabel(container, 'Remove credential for OpenAI'))).toBe(false);

      // Open Manage, save a key so confirmation banner ("Default model for new chats") opens,
      // then type an unsaved draft and delete DeepInfra.
      await React.act(async () => {
        findByAriaLabel(container, 'Manage DeepInfra')!.click();
      });
      const setInputValue = (el: DomEl, val: string) => {
        const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'))!;
        const props = (el as unknown as Record<string, { onChange?: (e: unknown) => void }>)[propsKey];
        props?.onChange?.({ target: { value: val } });
      };
      await React.act(async () => {
        setInputValue(findByAriaLabel(container, 'API key for DeepInfra')!, 'saved-secret-key');
      });
      await React.act(async () => {
        findButtonByText(container, 'Save key')!.click();
        await flushMicrotasks();
      });
      expect(Boolean(findByAriaLabel(container, 'Default model for new chats', 'region'))).toBe(true);
      notifyCalls.length = 0;

      // Type a replacement draft before removing.
      await React.act(async () => {
        setInputValue(findByAriaLabel(container, 'API key for DeepInfra')!, 'draft-unsaved-secret');
      });
      await React.act(async () => {
        findByAriaLabel(container, 'Remove credential for DeepInfra')!.click();
      });
      const confirmGroup = findByAriaLabel(container, 'Remove DeepInfra', 'group');
      expect(Boolean(confirmGroup)).toBe(true);

      // Submit failing DELETE: in-flight disables Remove credential & Keep credential and prevents duplicate submit.
      await React.act(async () => {
        findButtonByText(confirmGroup!, 'Remove credential')!.click();
      });
      expect(deleteAttempts).toBe(1);
      expect(findButtonByText(confirmGroup!, 'Removing…')!.disabled).toBe(true);
      expect(findButtonByText(confirmGroup!, 'Keep credential')!.disabled).toBe(true);
      await React.act(async () => {
        findButtonByText(confirmGroup!, 'Removing…')!.click();
      });
      expect(deleteAttempts).toBe(1);

      await React.act(async () => {
        resolveDelete({ ok: false, status: 500, data: { error: 'backend unreachable' } });
        await flushMicrotasks();
      });
      // Confirmation stays open on failure and renders host-named alert inside the confirmation card.
      expect(Boolean(findByAriaLabel(container, 'Remove DeepInfra', 'group'))).toBe(true);
      const alerts = findAllRoles(container, 'alert');
      expect(alerts.some((el) => el.textContent.includes('Studio Mac') && el.textContent.includes('DeepInfra'))).toBe(true);

      // Retry DELETE and succeed: DeepInfra leaves Your providers cleanly, no draft/confirmation/error remains,
      // and notifyChanged fires with upstream: false.
      await React.act(async () => {
        findButtonByText(findByAriaLabel(container, 'Remove DeepInfra', 'group')!, 'Remove credential')!.click();
      });
      state[0]!.credential = null;
      await React.act(async () => {
        resolveDelete({ ok: true, status: 200, data: { ok: true, provider: 'deepinfra', credential: null } });
        await flushMicrotasks();
      });
      expect(deleteAttempts).toBe(2);
      expect(findByAriaLabel(container, 'Remove DeepInfra', 'group')?.getAttribute('aria-label') ?? null).toBeNull();
      expect(findByAriaLabel(container, 'Default model for new chats', 'region')?.getAttribute('aria-label') ?? null).toBeNull();
      expect(findByAriaLabel(container, 'Manage DeepInfra')?.getAttribute('aria-label') ?? null).toBeNull();
      expect(findAllRoles(container, 'alert').map((el) => el.textContent)).toEqual([]);
      expect(notifyCalls).toEqual([{ id: 'pi:studio', options: { upstream: false } }]);
    } finally {
      await restore();
    }
  });

  test('shows calm inline envVar notice after removing a saved credential backed by an environment variable', async () => {
    const state: ProviderState[] = [
      { id: 'openai', name: 'OpenAI', credential: 'api_key', envVar: 'OPENAI_API_KEY', signIn: null },
    ];
    const { container, root, restore } = setupDom(async (_endpointId, path, init) => {
      if (path === '/providers' && (!init?.method || init.method === 'GET')) {
        return {
          ok: true,
          status: 200,
          data: {
            providers: state.map((p) => ({
              ...p,
              envVar: p.credential ? undefined : p.envVar,
            })),
            default: null,
          },
        };
      }
      if (path === '/providers/openai' && init?.method === 'DELETE') {
        state[0]!.credential = null;
        return { ok: true, status: 200, data: { ok: true, provider: 'openai', credential: null } };
      }
      if (path === '/custom-providers') {
        return { ok: true, status: 200, data: { providers: [] } };
      }
      if (path === '/local-runtimes/ollama') {
        return {
          ok: true,
          status: 200,
          data: {
            baseUrl: 'http://127.0.0.1:11434',
            defaultBaseUrl: 'http://127.0.0.1:11434',
            customAddress: false,
            running: false,
            hasModels: false,
            models: [],
          },
        };
      }
      return { ok: false, status: 404 };
    });

    try {
      await React.act(async () => {
        root.render(
          <ProvidersSettings
            inventory
            endpoints={[endpoint]}
            instances={[instance]}
            onDefaultChange={() => undefined}
          />,
        );
        await flushMicrotasks();
      });

      await React.act(async () => {
        findByAriaLabel(container, 'Manage OpenAI')!.click();
      });
      await React.act(async () => {
        const input = findByAriaLabel(container, 'API key for OpenAI')!;
        const propsKey = Object.keys(input).find((k) => k.startsWith('__reactProps$'))!;
        const props = (input as unknown as Record<string, { onChange?: (e: unknown) => void }>)[propsKey];
        props?.onChange?.({ target: { value: 'stale-openai-draft' } });
      });
      await React.act(async () => {
        findByAriaLabel(container, 'Remove credential for OpenAI')!.click();
      });
      await React.act(async () => {
        findButtonByText(findByAriaLabel(container, 'Remove OpenAI', 'group')!, 'Remove credential')!.click();
        await flushMicrotasks();
      });

      expect(findByAriaLabel(container, 'API key for OpenAI')?.value ?? '').toBe('');
      const statuses = findAllRoles(container, 'status');
      expect(statuses.length).toBeGreaterThan(0);
      const notice = statuses.map((el) => el.textContent).join(' ');
      expect(notice).toContain('Saved key removed');
      expect(notice).toContain('OPENAI_API_KEY');
      expect(notice).toMatch(/unset/i);
      expect(notice).toMatch(/restart Kiln/i);
    } finally {
      await restore();
    }
  });
});

describe('CustomProviders removal guards and error handling', () => {
  test('disables Cancel while DELETE is in flight, keeps confirmation on error, and updates list cleanly on success', async () => {
    let customList = [
      { id: 'custom-1', name: 'Local vLLM', baseUrl: 'http://127.0.0.1:8000/v1', modelIds: ['qwen-7b'], hasApiKey: false },
    ];
    let resolveDelete!: (res: { ok: boolean; status: number; data?: unknown }) => void;
    let changes = 0;

    const { container, root, restore } = setupDom(async (_endpointId, path, init) => {
      if (path === '/custom-providers' && (!init?.method || init.method === 'GET')) {
        return { ok: true, status: 200, data: { providers: customList } };
      }
      if (path === '/custom-providers/custom-1' && init?.method === 'DELETE') {
        return await new Promise((resolve) => {
          resolveDelete = resolve;
        });
      }
      return { ok: false, status: 404 };
    });

    try {
      await React.act(async () => {
        root.render(
          <CustomProviders
            endpointId="pi:studio"
            hostName="Studio Mac"
            onChange={async () => {
              changes += 1;
            }}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      await React.act(async () => {
        findByAriaLabel(container, 'Remove Local vLLM')!.click();
      });
      const group = findByAriaLabel(container, 'Remove Local vLLM', 'group')!;
      await React.act(async () => {
        findButtonByText(group, 'Confirm remove')!.click();
      });
      expect(findButtonByText(group, 'Removing…')!.disabled).toBe(true);
      expect(findButtonByText(group, 'Cancel')!.disabled).toBe(true);

      await React.act(async () => {
        resolveDelete({ ok: false, status: 500, data: { error: 'host offline' } });
        await flushMicrotasks();
      });
      expect(Boolean(findByAriaLabel(container, 'Remove Local vLLM', 'group'))).toBe(true);
      const errStatus = findAllRoles(container, 'status');
      expect(errStatus.some((el) => el.textContent.includes('Studio Mac') && el.textContent.includes('Local vLLM'))).toBe(true);

      await React.act(async () => {
        findButtonByText(findByAriaLabel(container, 'Remove Local vLLM', 'group')!, 'Confirm remove')!.click();
      });
      customList = [];
      await React.act(async () => {
        resolveDelete({ ok: true, status: 200, data: { ok: true } });
        await flushMicrotasks();
      });
      expect(findByAriaLabel(container, 'Remove Local vLLM')?.getAttribute('aria-label') ?? null).toBeNull();
      expect(container.textContent).not.toContain('Local vLLM');
      expect(changes).toBe(1);
    } finally {
      await restore();
    }
  });
});
