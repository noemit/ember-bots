import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import ChatView from '../src/components/ChatView';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { questionDrafts } from '../src/lib/asyncQuestionDrafts';
import { seedIdentity } from '../src/blob/seed';
import type {
  ChatMessage,
  Instance,
  QuestionRequest,
  Session,
  StoredComposerDraft,
  ViewSettings,
} from '../src/types';
import type { ThreadRow } from '../src/lib/crew';

// Pre-warm lazy chunks before mounting so React.lazy resolves on the initial act() pass.
await import('../src/components/Transcript');

class StubElement {
  nodeType = 1;
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  childNodes: Array<StubElement | StubText> = [];
  parentNode: StubElement | null = null;
  ownerDocument: StubDocument;
  value = '';
  selectionStart = 0;
  scrollHeight = 36;
  scrollTop = 0;
  clientHeight = 600;
  style: Record<string, unknown> = {
    height: '36px',
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

  contains(other: unknown): boolean {
    let cursor = other as { parentNode?: unknown } | null;
    while (cursor) {
      if (cursor === this) return true;
      cursor = (cursor.parentNode as { parentNode?: unknown } | null) ?? null;
    }
    return false;
  }

  focus(): void {}
  scrollTo(): void {}
  scrollIntoView(): void {}
  setSelectionRange(start: number): void {
    this.selectionStart = start;
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
    return { x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 480, width: 640, height: 480 };
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

  addEventListener(): void {}
  removeEventListener(): void {}
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

describe('ChatView composer keystroke memoization', () => {
  test('typing in the composer and flushing draft saves does not re-render Transcript, CrewStrip, or QuestionsShelf', async () => {
    const scope = globalThis as Record<string, unknown>;
    const savedGlobals = new Map<string, { present: boolean; value: unknown }>();
    for (const key of ['window', 'document', 'Element', 'Node', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT']) {
      savedGlobals.set(key, { present: key in scope, value: scope[key] });
    }

    let nextTimerId = 1;
    const timers = new Map<number, { callback: () => void; delayMs: number }>();
    const doc = new StubDocument();
    const win: Record<string, unknown> = {
      innerHeight: 900,
      innerWidth: 1280,
      HTMLIFrameElement: class {},
      Element: StubElement,
      event: undefined,
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
      getSelection: () => ({ isCollapsed: true, rangeCount: 0, removeAllRanges: () => undefined }),
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      },
      cancelAnimationFrame: () => undefined,
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
      setInterval: () => nextTimerId++,
      clearInterval: () => undefined,
    };
    doc.defaultView = win;
    scope.window = win;
    scope.document = doc;
    scope.Element = StubElement;
    scope.Node = StubElement;
    scope.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    scope.IS_REACT_ACT_ENVIRONMENT = true;

    try {
      const container = doc.createElement('div');
      const root = createRoot(container as unknown as Element);

      const renders = { transcript: 0, crew: 0, questions: 0 };
      const instance: Instance = {
        id: 'pi:local',
        label: 'This computer',
        kind: 'pi',
        status: 'ready',
        attachable: true,
      };
      const session: Session = {
        id: '42',
        instanceId: 'pi:local',
        title: 'Audit chat',
        directory: '/work/ember',
        updated: 1_000,
      };
      const message: ChatMessage = {
        id: 'e1',
        role: 'assistant',
        text: 'Ready to inspect.',
        parts: [{ id: 'e1-0', type: 'text', text: 'Ready to inspect.' }],
        completed: true,
      };
      // `delivery` is read inside Transcript (never in ChatView's top-level body).
      Object.defineProperty(message, 'delivery', {
        enumerable: true,
        get() {
          renders.transcript += 1;
          return undefined;
        },
      });

      const worker: Session = {
        id: '99',
        instanceId: 'pi:local',
        title: 'Worker check',
        kind: 'worker',
        lead: '42',
        updated: 1_000,
      };
      // `promotedTo` on a worker brick is read inside CrewStrip (never in ChatView's top-level body).
      Object.defineProperty(worker, 'promotedTo', {
        enumerable: true,
        get() {
          renders.crew += 1;
          return undefined;
        },
      });
      const threadRows: ThreadRow[] = [{ worker, depth: 1, group: worker }];

      const asyncQuestion: QuestionRequest = {
        id: 'q-1',
        instanceId: 'pi:local',
        sessionId: '42',
        status: 'pending',
        questions: [{ question: 'Proceed with deploy?', header: 'Deploy', options: [] }],
      };
      // `recommendation` is read inside QuestionsShelf's QuestionRow (never in ChatView's top-level body).
      Object.defineProperty(asyncQuestion, 'recommendation', {
        enumerable: true,
        get() {
          renders.questions += 1;
          return undefined;
        },
      });

      const view: ViewSettings = {
        hideToolCalls: false,
        reasoningDisplay: 'collapsed',
        showQuestions: true,
        expandToolCalls: false,
        toolDisplay: 'collapsed',
        showMessageDetails: true,
        showAvatars: true,
        showActivityRail: true,
        compactSpacing: false,
        compactRail: false,
        autoFollow: true,
      };
      const identity = seedIdentity('pi:local::42');
      const messages = [message];
      const asyncQuestions = [asyncQuestion];
      let savedDrafts: Record<string, StoredComposerDraft> = {};

      const renderView = async (drafts: Record<string, StoredComposerDraft>) => {
        await React.act(async () => {
          root.render(
            <TooltipProvider>
              <ChatView
                session={session}
                instance={instance}
                newSessionInstanceId={null}
                newSessionPrefill={null}
                instances={[instance]}
                mentionNames={['Alpha bot', 'Beta bot']}
                projectsByInstance={{}}
                seed="pi:local::42"
                identity={identity}
                resolveDraftIdentity={() => identity}
                state="idle"
                mood="idle"
                blobStyle="buddy"
                messages={messages}
                messagesStatus="ready"
                historyComplete
                permissions={[]}
                questions={[]}
                asyncQuestions={asyncQuestions}
                models={[]}
                defaultModelId={null}
                recentModels={[]}
                sending={false}
                queue={null}
                reloading={false}
                bypass={false}
                view={view}
                sessionNotes={[]}
                notesKey="pi:local::42"
                savedComposerDrafts={drafts}
                composerDraftsHydrated
                onComposerDraftsChange={(changes) => {
                  const next = { ...savedDrafts };
                  for (const [key, value] of Object.entries(changes)) {
                    if (value === null) delete next[key];
                    else if (value) next[key] = value;
                  }
                  savedDrafts = next;
                }}
                onSaveNote={() => undefined}
                onUpdateNote={() => undefined}
                onDeleteNote={() => undefined}
                onAnnotate={async () => true}
                onSaveAnnotationNote={async () => true}
                quoteLinks={[]}
                onNavigateQuote={() => undefined}
                onViewChange={() => undefined}
                onBypassChange={() => undefined}
                onMarkMessageRead={() => undefined}
                onUndoMarkMessageRead={() => undefined}
                onMarkMessageUnread={() => undefined}
                onMarkAllRead={() => undefined}
                onNewSessionInstanceChange={() => undefined}
                onCreateAndSend={async () => true}
                onCancelNewSession={() => undefined}
                onSend={async () => true}
                onQueue={async () => true}
                onSendQueued={async () => true}
                onMoveQueued={async () => true}
                onRemoveQueued={async () => true}
                onReplaceQueued={async () => true}
                onRetryQueued={async () => true}
                onDiscardQueued={() => true}
                onReload={() => undefined}
                onAbort={() => undefined}
                onPermission={async () => true}
                onQuestion={async () => true}
                compacting={false}
                onCompact={() => undefined}
                threadRows={threadRows}
                onOpenWorker={() => undefined}
              />
            </TooltipProvider>
          );
        });
      };

      await renderView(savedDrafts);

      // Select Questions tab, then Tasks tab so both QuestionsShelf and CrewStrip have mounted & rendered.
      const findTab = (label: string) =>
        findElements(
          container,
          (el) =>
            el.getAttribute('role') === 'tab' &&
            el.childNodes.some((child) => child instanceof StubText && child.nodeValue === label)
        )[0];

      const questionsTab = findTab('Questions');
      expect(questionsTab).toBeDefined();
      await React.act(async () => {
        (reactPropsOf(questionsTab!).onClick as () => void)();
      });
      expect(renders.questions).toBeGreaterThan(0);
      expect(renders.transcript).toBeGreaterThan(0);

      // Switch to Tasks tab so CrewStrip is actively mounted while typing, and snapshot baseline counts.
      const tasksTab = findTab('Tasks');
      expect(tasksTab).toBeDefined();
      await React.act(async () => {
        (reactPropsOf(tasksTab!).onClick as () => void)();
      });
      expect(renders.crew).toBeGreaterThan(0);

      const baseline = { ...renders };

      // Type several keystrokes into the composer textarea (including an @mention query).
      const findComposer = () =>
        findElements(
          container,
          (el) => el.tagName === 'TEXTAREA' && el.getAttribute('aria-label') === 'Message your bot'
        )[0];

      for (const typed of ['H', 'He', 'Hello ', 'Hello @Al', 'Hello @Alpha bot please check']) {
        const composer = findComposer();
        expect(composer).toBeDefined();
        composer!.value = typed;
        composer!.selectionStart = typed.length;
        await React.act(async () => {
          const onChange = reactPropsOf(composer!).onChange as (event: unknown) => void;
          onChange({ target: composer, currentTarget: composer });
        });
      }

      // Neither Transcript, CrewStrip, nor QuestionsShelf re-rendered on any keystroke.
      expect(renders).toEqual(baseline);

      // Flush the 600ms debounced draft-save timer and re-render with updated savedComposerDrafts.
      for (const [id, entry] of [...timers.entries()]) {
        if (entry.delayMs === 600) {
          timers.delete(id);
          await React.act(async () => {
            entry.callback();
          });
        }
      }
      expect(savedDrafts['pi:local::42']?.text).toBe('Hello @Alpha bot please check');
      await renderView(savedDrafts);
      expect(renders).toEqual(baseline);

      // Switch back to Questions tab: Answer Mode opens, typing an answer draft skips Transcript/CrewStrip,
      // and Back to chat restores the main composer while QuestionsShelf stays open without re-rendering on keystrokes.
      await React.act(async () => {
        (reactPropsOf(findTab('Questions')!).onClick as () => void)();
      });
      const answerInput = findElements(
        container,
        (el) => el.tagName === 'TEXTAREA' && el.getAttribute('aria-label') === 'Your answer'
      )[0];
      expect(answerInput).toBeDefined();
      const baselineInAnswerMode = { ...renders };
      await React.act(async () => {
        answerInput!.value = 'Draft answer';
        const onChange = reactPropsOf(answerInput!).onChange as (event: unknown) => void;
        onChange({ target: answerInput, currentTarget: answerInput });
      });
      expect(renders.transcript).toBe(baselineInAnswerMode.transcript);
      expect(renders.crew).toBe(baselineInAnswerMode.crew);

      const backButton = findElements(
        container,
        (el) =>
          el.tagName === 'BUTTON' &&
          findElements(el, () => true).some(
            (child) =>
              (child as unknown as { textContent?: string }).textContent === 'Back to chat' ||
              child.childNodes.some((n) => n instanceof StubText && n.nodeValue === 'Back to chat')
          )
      )[0];
      expect(backButton).toBeDefined();
      await React.act(async () => {
        (reactPropsOf(backButton!).onClick as () => void)();
      });

      const baselineWithQuestionsOpen = { ...renders };
      for (const typed of ['Next', 'Next step']) {
        const composer = findComposer()!;
        composer.value = typed;
        composer.selectionStart = typed.length;
        await React.act(async () => {
          const onChange = reactPropsOf(composer).onChange as (event: unknown) => void;
          onChange({ target: composer, currentTarget: composer });
        });
      }
      expect(renders).toEqual(baselineWithQuestionsOpen);

      await React.act(async () => {
        root.unmount();
      });
    } finally {
      questionDrafts.clear();
      for (const [key, prior] of savedGlobals) {
        if (prior.present) scope[key] = prior.value;
        else delete scope[key];
      }
    }
  });
});
