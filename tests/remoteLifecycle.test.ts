import { expect, test } from 'bun:test';
import { questionDrafts } from '../src/lib/asyncQuestionDrafts';
import { composerMemory } from '../src/lib/composerDrafts';
import { reconcileFullTranscript } from '../src/lib/transcriptReconciliation';
import type { ChatMessage } from '../src/types';
import { canReloadRemote, remoteAuxiliaryDrafts, remoteUnsentText, setRemoteActiveWork, setRemoteDraftBlocker } from '../src/lib/remoteLifecycle';

// All traffic is stubbed. This test never probes a running Ember or changes network settings.
test('remote resume repairs reads, preserves private drafts and never replays an uncertain send', async () => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  class Source {
    static CLOSED = 2;
    static instances: Source[] = [];
    readyState = 0;
    onerror?: () => void;
    onopen?: () => void;
    onmessage?: (message: { data: string }) => void;
    constructor(readonly url: string) { Source.instances.push(this); }
    close() { this.readyState = 2; }
  }
  const win = Object.assign(new EventTarget(), { location: { href: 'https://ember.test/' }, setTimeout, clearTimeout, ember: undefined as unknown });
  const doc = Object.assign(new EventTarget(), { hidden: false, body: { dataset: {} as Record<string, string> } });
  const nav = { onLine: true };
  const calls: { path: string; init?: RequestInit }[] = [];
  let response: () => Promise<Response> = async () => Response.json({ composerDrafts: { desktop: { text: 'private desktop draft' } } });
  replace('window', win);
  replace('document', doc);
  replace('navigator', nav);
  replace('EventSource', Source);
  replace('fetch', async (path: string, init?: RequestInit) => { calls.push({ path, init }); return response(); });
  let unsubscribe: (() => void) | undefined;
  try {
    await import('../src/remoteBridge');
    const bridge = window.ember;
    const states: string[] = [];
    win.addEventListener('ember:remote-connection', (event) => states.push((event as CustomEvent).detail.state));
    let resumes = 0;
    let expired = 0;
    win.addEventListener('ember:remote-resume', () => resumes++);
    win.addEventListener('ember:session-expired', () => expired++);
    unsubscribe = bridge.onEvent!(() => {});
    Source.instances.at(-1)!.onopen!();
    expect(resumes).toBe(1);
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(Source.instances).toHaveLength(2);
    expect(Source.instances[0].readyState).toBe(Source.CLOSED);
    Source.instances.at(-1)!.onopen!();
    expect(resumes).toBe(2);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(Source.instances).toHaveLength(2);
    doc.hidden = false;
    win.dispatchEvent(new Event('online'));
    expect(Source.instances).toHaveLength(3);

    nav.onLine = false;
    response = async () => { throw new TypeError('network down'); };
    Source.instances.at(-1)!.onerror!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(expired).toBe(0);
    expect(states.at(-1)).toBe('offline');
    const beforeSend = calls.length;
    await expect(bridge.piRequest!('host', '/conversations/c/messages', { method: 'POST', body: { text: 'once' } })).rejects.toMatchObject({ kind: 'unreachable' });
    win.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.slice(beforeSend).filter((call) => call.path === '/remote/pi')).toHaveLength(1);
    expect(calls.at(-1)!.init!.cache).toBe('no-store');

    // Exercise the real piApi submit path: its desktop status:0 retry must not run remotely.
    const { piSendPrompt } = await import('../src/piApi');
    response = async () => Response.json({ ok: false, status: 0, data: {} });
    const beforeStatusZero = calls.length;
    await expect(piSendPrompt('host', 'conversation', { text: 'only once', configured: true })).rejects.toMatchObject({ kind: 'unreachable' });
    expect(calls.slice(beforeStatusZero).filter((call) => call.path === '/remote/pi')).toHaveLength(1);

    // The upstream accepted the POST, but the relay/proxy lost its response. Cover both
    // outer gateway errors and HTTP-200 wrappers carrying an upstream server error.
    for (const status of [500, 502, 503, 504]) {
      for (const envelope of [false, true]) {
        let forwarded = 0;
        response = async () => {
          forwarded++;
          return envelope
            ? Response.json({ ok: false, status, data: { error: 'response lost after placement' } })
            : Response.json({ error: 'response lost after placement' }, { status });
        };
        const beforeGateway = calls.length;
        let failure: unknown;
        try { await piSendPrompt('host', 'conversation', { text: 'already placed', configured: true }); }
        catch (error) { failure = error; }
        expect(failure).toMatchObject({ kind: 'unreachable', status });
        // App's catch excludes only definite rejection/expiry. This error must reach the
        // protected unconfirmed branch, not the failed bubble's new-id retry path.
        const kind = (failure as { kind: string }).kind;
        expect(['rejected', 'session-expired']).not.toContain(kind);
        const bubble: ChatMessage = { id: 'pending-original-id', role: 'user', text: 'already placed', parts: [], completed: true, delivery: 'unconfirmed' };
        const protectedIds = new Set([bubble.id]);
        const beforeEcho = reconcileFullTranscript([bubble], [], protectedIds);
        expect(beforeEcho.messages).toEqual([bubble]);
        expect(beforeEcho.reconciledOptimisticIds).toEqual([]);
        const echoed: ChatMessage = { ...bubble, id: 'server-entry', delivery: undefined };
        const afterEcho = reconcileFullTranscript(beforeEcho.messages, [echoed], protectedIds);
        expect(afterEcho.messages).toEqual([echoed]);
        expect(afterEcho.reconciledOptimisticIds).toEqual([bubble.id]);
        win.dispatchEvent(new Event('online'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(forwarded).toBe(1);
        expect(calls.slice(beforeGateway).filter((call) => call.path === '/remote/pi')).toHaveLength(1);
        expect(expired).toBe(0);
      }
    }

    nav.onLine = true;
    response = async () => Response.json({ composerDrafts: { desktop: { text: 'private desktop draft' } } });
    expect((await bridge.getSettings()).composerDrafts).toEqual({});
    await bridge.setSettings({ composerDraftChanges: { browser: { text: 'memory only', updatedAt: 1 } }, theme: 'stone' });
    expect(calls.at(-1)!.init!.body).not.toContain('memory only');
    expect((await bridge.getSettings()).composerDrafts.browser.text).toBe('memory only');

    expect(canReloadRemote()).toBe(true);
    const draft = { text: '', modelId: 'default', variant: '', attachments: [], replyContext: null };
    composerMemory.set('browser', { ...draft, text: 'unsent' });
    expect(canReloadRemote()).toBe(false);
    const check = new Event('ember:can-reload', { cancelable: true });
    expect(win.dispatchEvent(check)).toBe(false);
    const unload = new Event('beforeunload', { cancelable: true });
    expect(win.dispatchEvent(unload)).toBe(false);
    composerMemory.clear();
    composerMemory.set('browser', { ...draft, attachments: [{} as never] });
    expect(canReloadRemote()).toBe(false);
    composerMemory.set('browser', { ...draft, replyContext: {} as never });
    expect(canReloadRemote()).toBe(false);
    composerMemory.clear();
    remoteAuxiliaryDrafts.set('annotation', { question: '', annotationDraft: 'Unsent annotation', annotationQuote: 'Its exact source' });
    expect(canReloadRemote()).toBe(false);
    remoteAuxiliaryDrafts.clear();
    setRemoteDraftBlocker('side-question', true);
    expect(canReloadRemote()).toBe(false);
    setRemoteDraftBlocker('side-question', false);
    questionDrafts.put('host::81:decision', { text: 'Wait for logs', picked: ['Keep'] });
    expect(canReloadRemote()).toBe(false);
    expect(remoteUnsentText()).toContain('Keep\n\nWait for logs');
    questionDrafts.put('host::81:decision', { text: '', accepted: 'Keep\n\nWait for logs' });
    expect(canReloadRemote()).toBe(true);
    questionDrafts.clear();
    setRemoteActiveWork(true);
    expect(win.dispatchEvent(new Event('ember:can-reload', { cancelable: true }))).toBe(false);
    setRemoteActiveWork(false);
    let finish: (response: Response) => void = () => {};
    response = () => new Promise((resolve) => { finish = resolve; });
    const pending = bridge.piRequest!('host', '/send', { method: 'POST' });
    expect(canReloadRemote()).toBe(false);
    finish(Response.json({ ok: true }));
    await pending;
    expect(canReloadRemote()).toBe(true);

    response = async () => Response.json({}, { status: 400 });
    try { await bridge.getSettings(); throw new Error('Expected a rejected request'); }
    catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('Ember');
      expect(message).toMatch(/try again/i);
      expect(message).not.toMatch(/HTTP|undefined|null|stack/);
    }

    // A captive portal is not proof that the Ember login expired.
    response = async () => ({ redirected: true, url: 'https://portal.test/login', status: 200 }) as Response;
    await expect(bridge.getSettings()).rejects.toMatchObject({ kind: 'unreachable' });
    expect(expired).toBe(0);

    composerMemory.set('browser', { ...draft, text: 'copy before leaving' });
    const fullQuote = `Selected paragraph that must survive recovery. ${'More selected context. '.repeat(16)}\nSecond paragraph, including its ending.`;
    const fullReply = '  Keep the entire selected passage.\nDo not shorten this annotation.  ';
    const sideQuestion = '  Does the alternate approach still work?\nInclude both cases.  ';
    const auxiliary = { question: sideQuestion, annotationDraft: fullReply, annotationQuote: fullQuote };
    remoteAuxiliaryDrafts.set('expired-column', auxiliary);
    response = () => new Promise((resolve) => { finish = resolve; });
    const late = bridge.getSettings();
    response = async () => Response.json({ code: 'session-expired' }, { status: 401 });
    await expect(bridge.getSettings()).rejects.toMatchObject({ kind: 'session-expired' });
    expect(doc.body.dataset.remoteExpired).toBe('true');
    expect(states.at(-1)).toBe('expired');
    expect(composerMemory.get('browser')!.text).toBe('copy before leaving');
    expect(remoteAuxiliaryDrafts.get('expired-column')).toEqual(auxiliary);
    // Simulate the authenticated column unmounting: live blockers are
    // gone, but its expiry snapshot must still block reload and support lossless Copy.
    composerMemory.clear();
    setRemoteDraftBlocker('side-question', false);
    expect(canReloadRemote()).toBe(false);
    expect(win.dispatchEvent(new Event('ember:can-reload', { cancelable: true }))).toBe(false);
    const recovered = remoteUnsentText();
    expect(recovered).toContain(sideQuestion);
    expect(recovered).toContain(fullQuote);
    expect(recovered).toContain(fullReply);
    finish(Response.json({ composerDrafts: {} }));
    await expect(late).rejects.toMatchObject({ kind: 'session-expired' });
    const count = calls.length;
    await expect(bridge.getSettings()).rejects.toMatchObject({ kind: 'session-expired' });
    expect(calls).toHaveLength(count);
    expect(states.at(-1)).toBe('expired');
  } finally {
    unsubscribe?.();
    composerMemory.clear();
    questionDrafts.clear();
    remoteAuxiliaryDrafts.clear();
    setRemoteActiveWork(false);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
