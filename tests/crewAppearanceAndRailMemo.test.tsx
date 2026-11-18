import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { createAppIconDiagnosticLogger } from '../electron/appIconLog';
import LeftRail from '../src/components/LeftRail';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { useCrewAppearance } from '../src/hooks/useCrewAppearance';
import { CREW_PHASE_BUFFER_MS, nextCrewPhaseDelayMs } from '../src/lib/crewMood';
import { seedIdentity } from '../src/blob/seed';
import type { AvatarIdentity, BallMood, Instance, Project, Session } from '../src/types';

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
  };
  attributes = new Map<string, string>();

  constructor(tagName: string, ownerDocument: StubDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
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

  addEventListener(): void {}
  removeEventListener(): void {}
  querySelector(): null {
    return null;
  }
  querySelectorAll(): never[] {
    return [];
  }
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
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
  defaultView: Record<string, unknown> | null = null;
  private listeners = new Map<string, Set<() => void>>();

  constructor() {
    this.documentElement = new StubElement('html', this);
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
}

const withMinimalDom = async (
  fn: (env: {
    doc: StubDocument;
    timers: Map<number, { callback: () => void; delayMs: number }>;
    intervalCalls: number[];
    advanceClock: (ms: number) => void;
    mount: () => { root: ReturnType<typeof createRoot>; unmount: () => Promise<void> };
  }) => Promise<void>
) => {
  const scope = globalThis as Record<string, unknown>;
  const hadWindow = 'window' in scope;
  const prevWindow = scope.window;
  const hadDocument = 'document' in scope;
  const prevDocument = scope.document;
  const hadResizeObserver = 'ResizeObserver' in scope;
  const prevResizeObserver = scope.ResizeObserver;
  const hadAct = 'IS_REACT_ACT_ENVIRONMENT' in scope;
  const prevAct = scope.IS_REACT_ACT_ENVIRONMENT;
  const prevPerfNow = performance.now.bind(performance);

  let fakeNow = 1_000;
  let nextTimerId = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  const intervalCalls: number[] = [];
  const doc = new StubDocument();

  const win: Record<string, unknown> = {
    HTMLIFrameElement: class {},
    Element: StubElement,
    event: undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    setTimeout: (callback: () => void, delayMs = 0) => {
      const id = nextTimerId++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    setInterval: (_callback: () => void, delayMs = 0) => {
      intervalCalls.push(delayMs);
      return nextTimerId++;
    },
    clearInterval: () => undefined,
  };
  doc.defaultView = win;
  scope.window = win;
  scope.document = doc;
  scope.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  performance.now = () => fakeNow;

  try {
    await fn({
      doc,
      timers,
      intervalCalls,
      advanceClock: (ms: number) => {
        fakeNow += ms;
      },
      mount: () => {
        const container = doc.createElement('div');
        const root = createRoot(container as unknown as Element);
        return {
          root,
          unmount: async () => {
            await React.act(async () => {
              root.unmount();
            });
          },
        };
      },
    });
  } finally {
    performance.now = prevPerfNow;
    if (hadWindow) scope.window = prevWindow;
    else delete scope.window;
    if (hadDocument) scope.document = prevDocument;
    else delete scope.document;
    if (hadResizeObserver) scope.ResizeObserver = prevResizeObserver;
    else delete scope.ResizeObserver;
    if (hadAct) scope.IS_REACT_ACT_ENVIRONMENT = prevAct;
    else delete scope.IS_REACT_ACT_ENVIRONMENT;
  }
};

describe('useCrewAppearance boundary scheduling and reference stability', () => {
  test('schedules one boundary setTimeout (+5ms), never setInterval, and preserves reference equality across non-flipping timestamps', async () => {
    await withMinimalDom(async ({ doc, timers, intervalCalls, advanceClock, mount }) => {
      const { root, unmount } = mount();
      const snapshots: Array<Record<string, BallMood>> = [];

      function Harness({
        baseMoods,
        crewKeys,
      }: {
        baseMoods: Record<string, BallMood>;
        crewKeys: ReadonlySet<string>;
      }) {
        const moods = useCrewAppearance(baseMoods, crewKeys);
        snapshots.push(moods);
        return null;
      }

      const initialKeys = new Set(['host::leader']);
      const expectedFirstDelay = nextCrewPhaseDelayMs(initialKeys, 0)! + CREW_PHASE_BUFFER_MS;

      await React.act(async () => {
        root.render(
          <Harness
            baseMoods={{ 'host::leader': 'busy', 'host::idle': 'idle' }}
            crewKeys={initialKeys}
          />
        );
      });

      expect(intervalCalls).toHaveLength(0);
      expect(timers.size).toBe(1);
      const firstTimerEntry = [...timers.values()][0];
      expect(firstTimerEntry.delayMs).toBe(expectedFirstDelay);
      const firstMoods = snapshots[snapshots.length - 1];

      // Simulate polls at non-flipping timestamps with cloned baseMoods and a new Set reference.
      advanceClock(1_000);
      await React.act(async () => {
        root.render(
          <Harness
            baseMoods={{ 'host::leader': 'busy', 'host::idle': 'idle' }}
            crewKeys={new Set(['host::leader'])}
          />
        );
      });
      expect(snapshots[snapshots.length - 1]).toBe(firstMoods);
      expect(timers.size).toBe(1);

      // Pause while hidden mid-phase, then become visible again before the phase flips:
      // mood reference still holds and the remaining delay shrinks by elapsed visible time.
      advanceClock(1_000);
      doc.hidden = true;
      await React.act(async () => {
        doc.emit('visibilitychange');
      });
      expect(timers.size).toBe(0);
      advanceClock(20_000); // Hidden elapsed time must not advance the crew clock.
      doc.hidden = false;
      await React.act(async () => {
        doc.emit('visibilitychange');
      });
      expect(snapshots[snapshots.length - 1]).toBe(firstMoods);
      expect(timers.size).toBe(1);
      const resumedTimer = [...timers.values()][0];
      expect(resumedTimer.delayMs).toBe(nextCrewPhaseDelayMs(initialKeys, 2_000)! + CREW_PHASE_BUFFER_MS);

      // Fire the boundary timeout: the phase flips, returning a new moods object and scheduling the next boundary.
      advanceClock(resumedTimer.delayMs);
      timers.clear();
      await React.act(async () => {
        resumedTimer.callback();
      });
      const flippedMoods = snapshots[snapshots.length - 1];
      expect(flippedMoods).not.toBe(firstMoods);
      expect(flippedMoods['host::leader']).not.toBe(firstMoods['host::leader']);
      expect(timers.size).toBe(1);
      expect(intervalCalls).toHaveLength(0);

      await unmount();
    });
  });
});

describe('LeftRail SessionRow memoization', () => {
  test('updating one session mood or preview skips untouched SessionRow renders even when parent callbacks are inline', async () => {
    await withMinimalDom(async ({ mount }) => {
      const { root, unmount } = mount();
      const instances: Instance[] = [
        { id: 'local', label: 'Local', kind: 'local', status: 'ready', attachable: true },
      ];
      const projectsByInstance: Record<string, Project[]> = {
        local: [{ id: 'proj-c', name: 'Project C', path: '/work/proj-c' }],
      };
      const rowRenders = { a: 0, b: 0, c: 0 };
      const trackedSession = (
        id: 'a' | 'b' | 'c',
        title: string,
        directory: string,
        updated: number
      ): Session => {
        const record: Session = { id, instanceId: 'local', title, directory, updated };
        Object.defineProperty(record, 'processes', {
          enumerable: true,
          get() {
            rowRenders[id] += 1;
            return undefined;
          },
        });
        return record;
      };
      const sessions: Session[] = [
        trackedSession('a', 'Alpha', '/work/alpha', 100),
        trackedSession('b', 'Bravo', '/work/bravo', 200),
        trackedSession('c', 'Charlie', '/work/proj-c', 300),
      ];
      const avatarIdentities: Record<string, AvatarIdentity> = {
        'local::a': seedIdentity('local::a'),
        'local::b': seedIdentity('local::b'),
        'local::c': seedIdentity('local::c'),
      };
      const emptySet = new Set<string>();
      const snoozed: string[] = [];
      const instanceDefaults = {};
      const scheduledTaskBySession = {};
      const groups: import('../src/types').SessionGroup[] = [];

      const renderRail = async (
        moods: Record<string, BallMood>,
        previews: Record<string, string>
      ) => {
        await React.act(async () => {
          root.render(
            <TooltipProvider>
              <LeftRail
                mode="normal"
                instances={instances}
                projectsByInstance={projectsByInstance}
                instanceDefaults={instanceDefaults}
                sessions={sessions}
                everySession={sessions}
                snoozedSessions={snoozed}
                onSnooze={() => undefined}
                moods={moods}
                previews={previews}
                selectedKey={null}
                selectedSession={null}
                avatarIdentities={avatarIdentities}
                blobStyle="buddy"
                compact={false}
                loading={false}
                startupMessage={null}
                mobileOpen={false}
                reloadingKeys={emptySet}
                archivingKeys={emptySet}
                visibleColumnKeys={emptySet}
                windowLabel={null}
                scheduledTaskBySession={scheduledTaskBySession}
                runningScheduledKeys={emptySet}
                onRunScheduledTask={() => undefined}
                onChangeScheduledTaskModel={() => undefined}
                onOpenArchive={() => undefined}
                onSelectSession={() => undefined}
                onOpenProject={() => undefined}
                onOpenSession={() => undefined}
                onReload={() => undefined}
                onArchive={() => undefined}
                onArchiveMany={() => undefined}
                onCustomizeAppearance={() => undefined}
                onMarkAllRead={() => undefined}
                unreadKeys={emptySet}
                quietKeys={emptySet}
                onQuietChange={() => undefined}
                onNewAgent={() => undefined}
                groups={groups}
                onOpenGroup={() => undefined}
                onUngroup={() => undefined}
                onManageGroup={() => undefined}
                onRenameSession={() => undefined}
              />
            </TooltipProvider>
          );
        });
      };

      await renderRail(
        { 'local::a': 'idle', 'local::b': 'idle', 'local::c': 'idle' },
        { 'local::a': 'Initial A', 'local::b': 'Initial B', 'local::c': 'Initial C' }
      );
      expect(rowRenders).toEqual({ a: 1, b: 1, c: 1 });

      // Flip only session A's mood: B (standalone row) and C (lone project row) must not re-render.
      await renderRail(
        { 'local::a': 'busy', 'local::b': 'idle', 'local::c': 'idle' },
        { 'local::a': 'Initial A', 'local::b': 'Initial B', 'local::c': 'Initial C' }
      );
      expect(rowRenders).toEqual({ a: 2, b: 1, c: 1 });

      // Update only session C's preview: A and B must not re-render.
      await renderRail(
        { 'local::a': 'busy', 'local::b': 'idle', 'local::c': 'idle' },
        { 'local::a': 'Initial A', 'local::b': 'Initial B', 'local::c': 'Updated C' }
      );
      expect(rowRenders).toEqual({ a: 2, b: 1, c: 2 });

      await unmount();
    });
  });
});

describe('createAppIconDiagnosticLogger', () => {
  test('debounces async writes and skips redundant null issue clears when no prior issue existed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-app-icon-'));
    const file = path.join(dir, 'app-icon.log');
    try {
      const logger = createAppIconDiagnosticLogger(() => file, { debounceMs: 50 });
      const ctx = { platform: 'darwin', hasDock: true, windows: 1, now: () => '2026-11-18T00:00:00.000Z' };

      // Redundant null clear with no prior failure writes nothing.
      expect(logger.reportIssue(null, ctx)).toEqual({ ok: true, written: false });
      await logger.flush();
      await expect(fs.readFile(file, 'utf8')).rejects.toThrow();

      // Failure report sets prior issue; subsequent null clear records recovery once, then skips duplicates.
      expect(logger.reportIssue('render failed: canvas unavailable', ctx)).toEqual({ ok: true, written: true });
      expect(logger.reportIssue(null, ctx)).toEqual({ ok: true, written: true });
      expect(logger.reportIssue(null, ctx)).toEqual({ ok: true, written: false });
      await logger.flush();

      const content = await fs.readFile(file, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('failed: renderer: render failed: canvas unavailable');
      expect(lines[1]).toContain('ok bytes=0');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
