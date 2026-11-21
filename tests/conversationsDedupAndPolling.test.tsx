import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
  loadAutoAcceptPolicy,
  loadMessageTailPage,
  loadSessionStates,
  loadSessions,
  OPEN_MESSAGE_TAIL_LIMIT,
  setAutoAccept,
} from '../src/api';
import { createPollController, usePoll } from '../src/hooks/usePoll';
import {
  invalidatePiConversationsCache,
  PI_CONVERSATIONS_CACHE_TTL_MS,
  piRenameSession,
  rememberPiInstances,
} from '../src/piApi';

type RecordedCall = {
  endpointId: string;
  method: string;
  path: string;
  body?: unknown;
};

const withMockEmber = async (
  handlers: {
    piRequest?: (
      endpointId: string,
      path: string,
      init?: { method?: string; body?: unknown }
    ) => Promise<{ ok: boolean; status: number; data: unknown }>;
    request?: (
      instanceId: string,
      method: string,
      path: string,
      body?: unknown
    ) => Promise<{ ok: boolean; status: number; data: unknown }>;
  },
  fn: () => Promise<void>
) => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    ember: {
      piRequest: handlers.piRequest,
      request: handlers.request,
    },
  };
  try {
    await fn();
  } finally {
    invalidatePiConversationsCache();
    if (previousWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  }
};

describe('GET /conversations in-flight + short-TTL deduplication', () => {
  test('simultaneous session, state, and auto-accept loads share 1 HTTP request', async () => {
    const calls: RecordedCall[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await withMockEmber(
      {
        piRequest: async (endpointId, reqPath, init) => {
          calls.push({ endpointId, method: init?.method ?? 'GET', path: reqPath, body: init?.body });
          await gate;
          return {
            ok: true,
            status: 200,
            data: {
              conversations: [
                { id: 11, title: 'Audit speed', busy: true, autoAccept: true, updatedAt: 1_000 },
                { id: 12, title: 'Quiet chat', busy: false, autoAccept: false, updatedAt: 900 },
              ],
            },
          };
        },
      },
      async () => {
        rememberPiInstances([{ id: 'pi:local', kind: 'pi' }]);
        const pending = Promise.all([
          loadSessions('pi:local'),
          loadSessionStates('pi:local'),
          loadAutoAcceptPolicy('pi:local'),
        ]);
        expect(calls).toHaveLength(1);
        release();
        const [sessions, states, policy] = await pending;
        expect(calls).toEqual([{ endpointId: 'pi:local', method: 'GET', path: '/conversations', body: undefined }]);
        expect(sessions?.map((s) => s.id)).toEqual(['11', '12']);
        expect(states).toEqual({
          'pi:local::11': 'active',
          'pi:local::12': 'idle',
        });
        expect(policy).toEqual({
          supported: true,
          sessions: { '11': true, '12': false },
        });

        // Follow-up read inside the short TTL reuses the settled payload without a second GET.
        const again = await loadSessionStates('pi:local');
        expect(again).toEqual({
          'pi:local::11': 'active',
          'pi:local::12': 'idle',
        });
        expect(calls).toHaveLength(1);
      }
    );
  });

  test('mutating piRequest invalidates settled and in-flight cache entries for that instance immediately', async () => {
    const calls: RecordedCall[] = [];
    let autoAcceptEnabled = false;
    let title = 'Initial';

    await withMockEmber(
      {
        piRequest: async (endpointId, reqPath, init) => {
          const method = init?.method ?? 'GET';
          calls.push({ endpointId, method, path: reqPath, body: init?.body });
          if (reqPath === '/conversations' && method === 'GET') {
            return {
              ok: true,
              status: 200,
              data: {
                conversations: [{ id: 7, title, busy: false, autoAccept: autoAcceptEnabled }],
              },
            };
          }
          if (reqPath === '/conversations/7/auto-accept' && method === 'PUT') {
            autoAcceptEnabled = Boolean((init?.body as { enabled?: boolean })?.enabled);
            return { ok: true, status: 200, data: { ok: true } };
          }
          if (reqPath === '/conversations/7' && method === 'PATCH') {
            title = String((init?.body as { title?: string })?.title ?? title);
            return { ok: true, status: 200, data: { id: 7, title } };
          }
          return { ok: false, status: 404, data: null };
        },
      },
      async () => {
        rememberPiInstances([
          { id: 'pi:a', kind: 'pi' },
          { id: 'pi:b', kind: 'pi' },
        ]);

        expect(await loadAutoAcceptPolicy('pi:a')).toEqual({ supported: true, sessions: { '7': false } });
        expect(await loadSessions('pi:b')).toHaveLength(1);
        expect(calls.filter((c) => c.path === '/conversations')).toHaveLength(2);

        // Mutating pi:a invalidates pi:a immediately without invalidating pi:b.
        await setAutoAccept('pi:a', '7', true);
        expect(await loadAutoAcceptPolicy('pi:a')).toEqual({ supported: true, sessions: { '7': true } });
        expect(calls.filter((c) => c.endpointId === 'pi:a' && c.path === '/conversations')).toHaveLength(2);

        await loadSessions('pi:b');
        expect(calls.filter((c) => c.endpointId === 'pi:b' && c.path === '/conversations')).toHaveLength(1);

        await piRenameSession('pi:a', '7', 'Renamed');
        const sessions = await loadSessions('pi:a');
        expect(sessions?.[0]?.title).toBe('Renamed');
      }
    );
  });

  test('TTL expiry and failed responses do not serve stale or broken payloads', async () => {
    let count = 0;
    let shouldFail = true;
    const realNow = Date.now;
    let fakeNow = 10_000;
    Date.now = () => fakeNow;

    try {
      await withMockEmber(
        {
          piRequest: async () => {
            count += 1;
            if (shouldFail) return { ok: false, status: 503, data: null };
            return {
              ok: true,
              status: 200,
              data: { conversations: [{ id: count, title: `Run ${count}` }] },
            };
          },
        },
        async () => {
          rememberPiInstances([{ id: 'pi:ttl', kind: 'pi' }]);
          expect(await loadSessions('pi:ttl')).toBeNull();
          shouldFail = false;
          // Failed response was not cached; immediate retry succeeds.
          expect((await loadSessions('pi:ttl'))?.[0]?.id).toBe('2');
          expect(count).toBe(2);

          fakeNow += PI_CONVERSATIONS_CACHE_TTL_MS - 1;
          expect((await loadSessions('pi:ttl'))?.[0]?.id).toBe('2');
          expect(count).toBe(2);

          fakeNow += 2;
          expect((await loadSessions('pi:ttl'))?.[0]?.id).toBe('3');
          expect(count).toBe(3);
        }
      );
    } finally {
      Date.now = realNow;
    }
  });
});

describe('usePoll and createPollController interval transitions', () => {
  const createFakeTimers = () => {
    let clock = 1_000;
    let nextId = 1;
    const pending = new Map<number, { at: number; fn: () => void }>();

    return {
      now: () => clock,
      pendingCount: () => pending.size,
      nextFireIn: () => {
        const times = [...pending.values()].map((entry) => entry.at - clock);
        return times.length ? Math.min(...times) : null;
      },
      env: {
        now: () => clock,
        isHidden: () => false,
        setTimer: (fn: () => void, ms: number) => {
          const id = nextId++;
          pending.set(id, { at: clock + ms, fn });
          return id as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: (timer: ReturnType<typeof setTimeout>) => {
          pending.delete(timer as unknown as number);
        },
      },
      advance: async (ms: number) => {
        const target = clock + ms;
        while (true) {
          let earliestId: number | undefined;
          let earliestAt = Infinity;
          for (const [id, entry] of pending) {
            if (entry.at <= target && entry.at < earliestAt) {
              earliestAt = entry.at;
              earliestId = id;
            }
          }
          if (earliestId === undefined) break;
          const entry = pending.get(earliestId)!;
          pending.delete(earliestId);
          clock = entry.at;
          entry.fn();
          await Promise.resolve();
          await Promise.resolve();
        }
        clock = target;
        await Promise.resolve();
      },
    };
  };

  test('changing intervalMs while enabled reschedules without firing a duplicate immediate tick', async () => {
    const timers = createFakeTimers();
    let runs = 0;
    const controller = createPollController(async () => {
      runs += 1;
    }, timers.env);

    controller.update(10_000, true, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(timers.nextFireIn()).toBe(10_000);

    // WS connects 20ms later -> interval lengthens to 60_000ms without re-firing immediately.
    await timers.advance(20);
    controller.update(60_000, true, true);
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(timers.nextFireIn()).toBe(59_980);

    // Column becomes busy 500ms later -> interval shortens to 3_000ms; waits remaining 2,480ms.
    await timers.advance(500);
    controller.update(3_000, true, true);
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(timers.nextFireIn()).toBe(2_480);

    await timers.advance(2_480);
    expect(runs).toBe(2);
    controller.dispose();
  });

  test('changing intervalMs while a run is in flight does not start a second concurrent run', async () => {
    const timers = createFakeTimers();
    let runs = 0;
    let release!: () => void;
    const controller = createPollController(
      () =>
        new Promise<void>((resolve) => {
          runs += 1;
          release = resolve;
        }),
      timers.env
    );

    controller.update(10_000, true, true);
    expect(runs).toBe(1);

    // Interval changes mid-flight; still only 1 active run, and completion adopts 60_000ms.
    controller.update(60_000, true, true);
    expect(runs).toBe(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(timers.nextFireIn()).toBe(60_000);
    controller.dispose();
  });

  test('immediate: false waits one full interval on enable so dead->live handoff stays quiet', async () => {
    const timers = createFakeTimers();
    let deadRuns = 0;
    let liveRuns = 0;
    const deadPoll = createPollController(async () => {
      deadRuns += 1;
    }, timers.env);
    const livePoll = createPollController(async () => {
      liveRuns += 1;
    }, timers.env);

    deadPoll.update(10_000, true, false);
    livePoll.update(60_000, false, false);
    await Promise.resolve();
    expect(deadRuns).toBe(0);
    expect(liveRuns).toBe(0);

    // WS connects 15ms after startup: deadPoll disables, livePoll enables with immediate: false.
    await timers.advance(15);
    deadPoll.update(10_000, false, false);
    livePoll.update(60_000, true, false);
    await Promise.resolve();
    expect(deadRuns).toBe(0);
    expect(liveRuns).toBe(0);
    expect(timers.nextFireIn()).toBe(60_000);

    await timers.advance(60_000);
    expect(liveRuns).toBe(1);
    deadPoll.dispose();
    livePoll.dispose();
  });

  test('React usePoll hook does not re-fire immediately when intervalMs prop changes', async () => {
    class MiniNode {
      nodeType = 1;
      tagName = 'DIV';
      namespaceURI = 'http://www.w3.org/1999/xhtml';
      childNodes: MiniNode[] = [];
      parentNode: MiniNode | null = null;
      ownerDocument: unknown;
      style: Record<string, unknown> = {};
      appendChild<T extends MiniNode>(child: T): T {
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
      }
      removeChild<T extends MiniNode>(child: T): T {
        this.childNodes = this.childNodes.filter((entry) => entry !== child);
        child.parentNode = null;
        return child;
      }
      insertBefore<T extends MiniNode>(child: T): T {
        return this.appendChild(child);
      }
      addEventListener() {}
      removeEventListener() {}
    }
    const prevDoc = (globalThis as { document?: unknown }).document;
    const prevWin = (globalThis as { window?: unknown }).window;
    const prevAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    const doc: Record<string, unknown> = {
      hidden: false,
      nodeType: 9,
      activeElement: null,
      createElement: () => {
        const n = new MiniNode();
        n.ownerDocument = doc;
        return n;
      },
      createTextNode: () => new MiniNode(),
      addEventListener() {},
      removeEventListener() {},
    };
    const win = {
      document: doc,
      HTMLIFrameElement: class {},
      event: undefined,
      addEventListener() {},
      removeEventListener() {},
    };
    doc.defaultView = win;
    (globalThis as { document?: unknown }).document = doc;
    (globalThis as { window?: unknown }).window = win;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    let ticks = 0;
    const Probe = ({ intervalMs, enabled }: { intervalMs: number; enabled: boolean }) => {
      usePoll(
        async () => {
          ticks += 1;
        },
        intervalMs,
        enabled
      );
      return null;
    };

      const container = (doc.createElement as () => MiniNode)();
      const root = createRoot(container as unknown as Element);
      try {
        await React.act(async () => {
          root.render(<Probe intervalMs={10_000} enabled={true} />);
        });
        expect(ticks).toBe(1);

        await React.act(async () => {
          root.render(<Probe intervalMs={60_000} enabled={true} />);
        });
        expect(ticks).toBe(1);

        await React.act(async () => {
          root.unmount();
        });
      } finally {
        if (prevDoc === undefined) delete (globalThis as { document?: unknown }).document;
        else (globalThis as { document?: unknown }).document = prevDoc;
        if (prevWin === undefined) delete (globalThis as { window?: unknown }).window;
        else (globalThis as { window?: unknown }).window = prevWin;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prevAct;
      }
  });
});

describe('bounded tail session open & 60s busy safety poll', () => {
  test('loadMessageTailPage uses bounded single-page tail and reports completeness accurately', async () => {
    const paths: string[] = [];
    let hasOlder = true;

    await withMockEmber(
      {
        piRequest: async (_endpointId, reqPath) => {
          paths.push(reqPath);
          return {
            ok: true,
            status: 200,
            data: {
              entries: [
                { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'latest' }], stopReason: 'stop', timestamp: 2 }] },
                { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'first', timestamp: 1 }] },
              ],
              ...(hasOlder ? { next: { before: 1 } } : {}),
            },
          };
        },
        request: async (_instanceId, _method, reqPath) => {
          paths.push(reqPath);
          return {
            ok: true,
            status: 200,
            data: {
              data: [{ id: 'm1', type: 'user', time: { created: 1 }, text: 'hello' }],
              cursor: { next: hasOlder ? 'older-cursor' : null },
            },
          };
        },
      },
      async () => {
        rememberPiInstances([{ id: 'pi:local', kind: 'pi' }]);

        const longPi = await loadMessageTailPage('pi:local', '42', undefined, OPEN_MESSAGE_TAIL_LIMIT);
        expect(paths[0]).toBe('/conversations/42/entries?limit=80&docs=1');
        expect(longPi.complete).toBe(false);
        expect(longPi.messages.map((m) => m.text)).toEqual(['first', 'latest']);

        hasOlder = false;
        const shortPi = await loadMessageTailPage('pi:local', '42', undefined, OPEN_MESSAGE_TAIL_LIMIT);
        expect(shortPi.complete).toBe(true);

        hasOlder = true;
        const longOc = await loadMessageTailPage('oc:local', 's1', undefined, OPEN_MESSAGE_TAIL_LIMIT);
        expect(paths[2]).toBe('/api/session/s1/message?order=desc&limit=120');
        expect(longOc.complete).toBe(false);

        hasOlder = false;
        const shortOc = await loadMessageTailPage('oc:local', 's1', undefined, OPEN_MESSAGE_TAIL_LIMIT);
        expect(shortOc.complete).toBe(true);
      }
    );
  });

  test('App showTranscript and visible-column safety poll stay on bounded tail reads without eager full walks', () => {
    const streamsSource = fs.readFileSync(
      path.join(import.meta.dir, '../src/app/useInstancePollingAndStreams.ts'),
      'utf8'
    );
    const showStart = streamsSource.indexOf('const showTranscript = useStableCallback');
    const showEnd = streamsSource.indexOf('// Selecting a column refreshes it immediately', showStart);
    expect(showStart).toBeGreaterThan(0);
    expect(showEnd).toBeGreaterThan(showStart);
    const showBlock = streamsSource.slice(showStart, showEnd);
    expect(showBlock).toContain('refreshMessageTail(ref)');
    expect(showBlock).not.toContain('refreshMessages(');

    const pollStart = streamsSource.indexOf('const anyColumnBusy = watchedSessionKeys.some');
    const pollEnd = streamsSource.indexOf('return {', pollStart);
    expect(pollStart).toBeGreaterThan(0);
    expect(pollEnd).toBeGreaterThan(pollStart);
    const pollBlock = streamsSource.slice(pollStart, pollEnd);
    expect(pollBlock).toContain('refreshMessageTail(ref)');
    expect(pollBlock).not.toContain('refreshMessages(');
  });
});
