import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import ChatView from '../src/components/ChatView';
import QuestionAnswerComposer from '../src/components/QuestionAnswerComposer';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { WorkspaceConnection, useWorkspaceConnection } from '../src/components/workspaceConnection';
import { questionDrafts } from '../src/lib/asyncQuestionDrafts';
import { piQuestionToQuestionRequest } from '../src/lib/piMapping';
import { questionKey } from '../src/lib/threadQuestions';
import { seedIdentity } from '../src/blob/seed';
import type {
  ChatMessage,
  Instance,
  QuestionAnswers,
  QuestionRequest,
  Session,
  StoredComposerDraft,
  ViewSettings,
} from '../src/types';
import type { ThreadRow } from '../src/lib/crew';

await import('../src/components/Transcript');

class StubElement {
  nodeType = 1;
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  childNodes: Array<StubElement | StubText> = [];
  parentNode: StubElement | null = null;
  ownerDocument: StubDocument;
  private _value = '';
  private _dirtyValue = false;
  private _defaultValue = '';
  selectionStart = 0;
  scrollHeight = 36;
  scrollTop = 0;
  clientHeight = 600;
  offsetHeight = 100;
  offsetTop = 0;
  clientTop = 0;
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

  get value(): string {
    return this._dirtyValue ? this._value : this._defaultValue;
  }

  set value(next: string) {
    this._dirtyValue = true;
    this._value = String(next);
  }

  get defaultValue(): string {
    return this._defaultValue;
  }

  set defaultValue(next: string) {
    this._defaultValue = String(next);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value) {
      const text = new StubText(String(value), this.ownerDocument);
      text.parentNode = this;
      this.childNodes.push(text);
    }
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

  focus(): void {
    this.ownerDocument.activeElement = this;
  }
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

  constructor(text: string, ownerDocument: StubDocument, nodeType = 3) {
    this.nodeValue = text;
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
  }

  get value(): string {
    return this._dirtyValue ? this._value : this._defaultValue;
  }

  set value(next: string) {
    this._dirtyValue = true;
    this._value = String(next);
  }

  get defaultValue(): string {
    return this._defaultValue;
  }

  set defaultValue(next: string) {
    this._defaultValue = String(next);
  }

  get textContent(): string {
    return this.nodeType === 8 ? '' : this.nodeValue;
  }

  set textContent(value: string) {
    this.nodeValue = String(value);
  }
}

class StubDocument {
  nodeType = 9;
  hidden = false;
  activeElement: StubElement | null = null;
  documentElement: StubElement;
  body: StubElement;
  defaultView: Record<string, unknown> | null = null;
  mockSelectorMatch: Element | null = null;

  constructor() {
    this.documentElement = new StubElement('html', this);
    this.body = new StubElement('body', this);
  }

  createElement(tag: string): StubElement {
    return new StubElement(tag, this);
  }

  createElementNS(_ns: string, tag: string): StubElement {
    return new StubElement(tag, this);
  }

  createTextNode(text: string): StubText {
    return new StubText(text, this, 3);
  }

  createComment(text: string): StubText {
    return new StubText(text, this, 8);
  }

  querySelector(): Element | null {
    return this.mockSelectorMatch;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

const textContentOf = (node: StubElement | StubText): string => node.textContent;

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

const setupDomEnv = () => {
  const scope = globalThis as Record<string, unknown>;
  const saved = new Map<string, { present: boolean; value: unknown }>();
  for (const key of ['window', 'document', 'Element', 'Node', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT']) {
    saved.set(key, { present: key in scope, value: scope[key] });
  }
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
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: () => 1,
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
  return {
    doc,
    restore() {
      questionDrafts.clear();
      for (const [key, prior] of saved) {
        if (prior.present) scope[key] = prior.value;
        else delete scope[key];
      }
    },
  };
};

const baseInstance: Instance = {
  id: 'pi:hearth',
  label: 'Kiln',
  kind: 'pi',
  status: 'ready',
  attachable: true,
};

const leaderSession: Session = {
  id: '16',
  instanceId: 'pi:hearth',
  title: 'Crew: auth refactor',
  directory: '/workspace/hearth',
  updated: 1_000,
};

const workerSession: Session = {
  id: '81',
  instanceId: 'pi:hearth',
  title: 'Backup audit',
  kind: 'worker',
  lead: '16',
  updated: 1_000,
};

const baseMessage: ChatMessage = {
  id: 'e1',
  role: 'assistant',
  text: 'Ready to proceed.',
  parts: [{ id: 'e1-0', type: 'text', text: 'Ready to proceed.' }],
  completed: true,
};

const baseView: ViewSettings = {
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

const ConnectionSpy = ({ onValue }: { onValue: (activeKey: string | null) => void }) => {
  const { activeKey } = useWorkspaceConnection();
  onValue(activeKey);
  return null;
};

describe('QuestionAnswerComposer and ChatView Spec Q integration', () => {
  test('supports single-composer answer mode, tab switching, WorkspaceConnection detachment on child task, Escape guard, drop guard, and 200 OK progression', async () => {
    const env = setupDomEnv();
    try {
      const container = env.doc.createElement('div');
      const root = createRoot(container as unknown as Element);

      const childQuestion = piQuestionToQuestionRequest('pi:hearth', {
        conversationId: '81',
        key: 'nested:decision',
        sourceTitle: 'Backup audit',
        question: 'Keep the migration backup?',
        options: ['Keep', 'Remove'],
        mode: 'async',
        revision: 3,
        status: 'pending',
        ancestry: [{ conversationId: '16', title: 'Crew: auth refactor' }],
      });
      const ownQuestion = piQuestionToQuestionRequest('pi:hearth', {
        conversationId: '16',
        key: 'own:decision',
        sourceTitle: 'Crew: auth refactor',
        question: 'Keep the rollout gradual?',
        options: ['Gradual', 'All at once'],
        mode: 'async',
        revision: 1,
        status: 'pending',
      });

      const submitted: Array<{ request: QuestionRequest; answers: QuestionAnswers | null }> = [];
      let aborted = 0;
      let latestConnectionKey: string | null = null;
      let currentQuestions: QuestionRequest[] = [childQuestion, ownQuestion];
      let savedDrafts: Record<string, StoredComposerDraft> = {};

      const renderApp = async (
        questions: QuestionRequest[],
        state: 'idle' | 'active' = 'idle'
      ) => {
        await React.act(async () => {
          root.render(
            <WorkspaceConnection activeKey="pi:hearth::16" color="var(--blob-0)">
              <ConnectionSpy onValue={(key) => { latestConnectionKey = key; }} />
              <TooltipProvider>
                <ChatView
                  session={leaderSession}
                  instance={baseInstance}
                  newSessionInstanceId={null}
                  newSessionPrefill={null}
                  instances={[baseInstance]}
                  mentionNames={[]}
                  projectsByInstance={{}}
                  seed="pi:hearth::16"
                  identity={seedIdentity('pi:hearth::16')}
                  resolveDraftIdentity={() => seedIdentity('pi:hearth::16')}
                  state={state}
                  mood={state === 'active' ? 'thinking' : 'idle'}
                  blobStyle="buddy"
                  messages={[baseMessage]}
                  messagesStatus="ready"
                  historyComplete
                  permissions={[]}
                  questions={[]}
                  asyncQuestions={questions}
                  models={[]}
                  defaultModelId={null}
                  recentModels={[]}
                  sending={false}
                  queue={null}
                  reloading={false}
                  bypass={false}
                  view={baseView}
                  sessionNotes={[]}
                  notesKey="pi:hearth::16"
                  savedComposerDrafts={savedDrafts}
                  composerDraftsHydrated
                  onComposerDraftsChange={(changes) => {
                    const next = { ...savedDrafts };
                    for (const [k, v] of Object.entries(changes)) {
                      if (v === null) delete next[k];
                      else if (v) next[k] = v;
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
                  onAbort={() => { aborted += 1; }}
                  onPermission={async () => true}
                  onQuestion={async (req, ans) => {
                    submitted.push({ request: req, answers: ans });
                    currentQuestions = currentQuestions.map((item) =>
                      questionKey(item) === questionKey(req)
                        ? {
                            ...item,
                            status: 'answered',
                            answer: (ans?.[0] ?? []).join('\n'),
                            receipt: {
                              requestId: req.mutation!.requestId,
                              revision: req.mutation!.revision,
                              answer: (ans?.[0] ?? []).join('\n'),
                              at: 1000,
                            },
                            delivery: { requestId: 'd1', status: 'held', holdReason: 'Waiting for inbox' },
                          }
                        : item
                    );
                    await renderApp(currentQuestions, state);
                    return true;
                  }}
                  compacting={false}
                  onCompact={() => undefined}
                  threadRows={[{ worker: workerSession, depth: 1, group: workerSession }] as ThreadRow[]}
                  onOpenWorker={() => undefined}
                />
              </TooltipProvider>
            </WorkspaceConnection>
          );
        });
      };

      await renderApp(currentQuestions, 'active');

      // 1. No arrival takeover: normal chat composer stays active on load & on arrival of a 3rd question.
      const mainComposer = () =>
        findElements(
          container,
          (el) =>
            el.tagName === 'TEXTAREA' &&
            (el.getAttribute('aria-label') === 'Message your bot' ||
              el.getAttribute('aria-label') === 'Queue a follow-up message')
        )[0];
      expect(mainComposer()).toBeDefined();
      expect(latestConnectionKey).toBe('pi:hearth::16');

      await React.act(async () => {
        const box = mainComposer()!;
        box.value = 'My working chat draft';
        (reactPropsOf(box).onChange as (e: unknown) => void)({ target: box, currentTarget: box });
      });

      const arrivedThird = piQuestionToQuestionRequest('pi:hearth', {
        conversationId: '81',
        key: 'arrived:later',
        sourceTitle: 'Backup audit',
        question: 'Archive old snapshots?',
        options: ['Archive'],
        mode: 'async',
        revision: 1,
        status: 'pending',
      });
      await renderApp([childQuestion, ownQuestion, arrivedThird], 'active');
      expect(mainComposer()).toBeDefined();
      expect(mainComposer()!.value).toBe('My working chat draft');

      // 2. Opening Questions tab enters single-composer Answer Mode for childQuestion.
      const tabNamed = (label: string) =>
        findElements(
          container,
          (el) =>
            el.getAttribute('role') === 'tab' &&
            el.childNodes.some((n) => n instanceof StubText && n.nodeValue === label)
        )[0];

      await React.act(async () => {
        (reactPropsOf(tabNamed('Questions')!).onClick as () => void)();
      });

      // Only one textarea exists (eliminated stacked double-textareas).
      expect(findElements(container, (el) => el.tagName === 'TEXTAREA')).toHaveLength(1);
      const answerSection = () =>
        findElements(container, (el) => el.getAttribute('data-question-answer-composer') === '')[0];
      expect(answerSection()).toBeDefined();
      expect(textContentOf(answerSection())).toContain('Answer for task · Backup audit');
      expect(textContentOf(answerSection())).not.toContain('task.');
      // Child task detaches WorkspaceConnection so LeftRail leader card does not falsely fuse.
      expect(latestConnectionKey).toBeNull();
      expect(
        findElements(container, (el) => el.getAttribute('data-connection-composer') === 'true')
      ).toHaveLength(0);

      // Stop generating remains accessible while busy in Answer Mode.
      const stopBtn = findElements(
        container,
        (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Stop generating'
      )[0];
      expect(stopBtn).toBeDefined();
      await React.act(async () => {
        (reactPropsOf(stopBtn!).onClick as () => void)();
      });
      expect(aborted).toBe(1);

      // Guarded file drop while Answer Mode is active does not attach to hidden chat draft.
      const mainEl = findElements(container, (el) => el.tagName === 'MAIN')[0];
      let dropPrevented = false;
      await React.act(async () => {
        (reactPropsOf(mainEl).onDrop as (e: unknown) => void)({
          dataTransfer: { types: ['Files'], files: [{ name: 'secret.png' }] },
          preventDefault: () => {
            dropPrevented = true;
          },
        });
      });
      expect(dropPrevented).toBe(true);
      expect(findElements(container, (el) => el.getAttribute('data-testid') === 'drop-overlay')).toHaveLength(0);

      // Select choices + type note on childQuestion.
      const buttonByText = (text: string) =>
        findElements(
          container,
          (el) => el.tagName === 'BUTTON' && textContentOf(el).includes(text)
        )[0];

      await React.act(async () => {
        (reactPropsOf(buttonByText('Remove')!).onClick as () => void)();
      });
      await React.act(async () => {
        (reactPropsOf(buttonByText('Keep')!).onClick as () => void)();
      });
      const noteInput = findElements(
        container,
        (el) => el.tagName === 'TEXTAREA' && el.getAttribute('aria-label') === 'Add a note'
      )[0];
      await React.act(async () => {
        noteInput.value = 'Verify checksums first';
        (reactPropsOf(noteInput).onChange as (e: unknown) => void)({
          target: noteInput,
          currentTarget: noteInput,
        });
      });
      expect(questionDrafts.get(questionKey(childQuestion))).toMatchObject({
        picked: ['Keep', 'Remove'],
        text: 'Verify checksums first',
      });

      // 3. Switching to Tasks tab temporarily restores main chat composer while keeping question draft.
      await React.act(async () => {
        (reactPropsOf(tabNamed('Tasks')!).onClick as () => void)();
      });
      expect(mainComposer()).toBeDefined();
      expect(mainComposer()!.value).toBe('My working chat draft');
      expect(latestConnectionKey).toBe('pi:hearth::16');

      // Switching back to Questions resumes Answer Mode with structured selections & note intact.
      await React.act(async () => {
        (reactPropsOf(tabNamed('Questions')!).onClick as () => void)();
      });
      expect(answerSection()).toBeDefined();
      expect(buttonByText('Keep')!.getAttribute('aria-pressed')).toBe('true');
      expect(buttonByText('Remove')!.getAttribute('aria-pressed')).toBe('true');
      expect(
        findElements(container, (el) => el.tagName === 'TEXTAREA')[0].value
      ).toBe('Verify checksums first');

      // 4. Paging to same-conversation question re-connects WorkspaceConnection and shows "Answer for this conversation".
      const nextPager = findElements(
        container,
        (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Next question'
      )[0];
      expect(nextPager).toBeDefined();
      expect(nextPager.getAttribute('class')).toContain('min-h-8');
      await React.act(async () => {
        (reactPropsOf(nextPager).onClick as () => void)();
      });
      expect(textContentOf(answerSection())).toContain('Answer for this conversation');
      expect(latestConnectionKey).toBe('pi:hearth::16');

      // 5. Escape is blocked when a higher dialog is present, and returns to chat when clear.
      env.doc.mockSelectorMatch = {} as Element;
      await React.act(async () => {
        (reactPropsOf(mainEl).onKeyDown as (e: unknown) => void)({
          key: 'Escape',
          defaultPrevented: false,
          preventDefault: () => {},
        });
      });
      expect(answerSection()).toBeDefined();

      env.doc.mockSelectorMatch = null;
      await React.act(async () => {
        (reactPropsOf(mainEl).onKeyDown as (e: unknown) => void)({
          key: 'Escape',
          defaultPrevented: false,
          preventDefault: () => {},
        });
      });
      expect(mainComposer()).toBeDefined();
      expect(mainComposer()!.value).toBe('My working chat draft');

      // 6. Re-open child question via the shelf Answer button and submit combined answer -> 200 OK advances to remaining pending question.
      const childAnswerBtn = findElements(
        container,
        (el) => el.tagName === 'BUTTON' && textContentOf(el) === 'Answer'
      )[0];
      expect(childAnswerBtn).toBeDefined();
      await React.act(async () => {
        (reactPropsOf(childAnswerBtn).onClick as () => void)();
      });
      expect(textContentOf(answerSection())).toContain('Answer for task · Backup audit');
      const sendAnswerBtn = findElements(
        container,
        (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Send answer'
      )[0];
      await React.act(async () => {
        await (reactPropsOf(sendAnswerBtn).onClick as () => Promise<void>)();
      });
      expect(submitted[0].answers).toEqual([['Keep\nRemove\n\nVerify checksums first']]);
      // Smoothly advanced to remaining pending question, never hijacked main Send button.
      expect(answerSection()).toBeDefined();

      // Answer remaining pending question -> exits Answer Mode cleanly to normal chat composer!
      currentQuestions = [ownQuestion];
      await renderApp(currentQuestions, 'idle');
      await React.act(async () => {
        (reactPropsOf(buttonByText('Gradual')!).onClick as () => void)();
      });
      const sendLastBtn = findElements(
        container,
        (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Send answer'
      )[0];
      await React.act(async () => {
        await (reactPropsOf(sendLastBtn).onClick as () => Promise<void>)();
        await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      });
      expect(mainComposer()).toBeDefined();
      expect(mainComposer()!.value).toBe('My working chat draft');
      const mainSend = findElements(
        container,
        (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Send'
      )[0];
      expect(mainSend).toBeDefined();
      expect(mainSend.getAttribute('aria-label')).toBe('Send');

      await React.act(async () => {
        root.unmount();
      });
    } finally {
      env.restore();
    }
  });

  test('respects single-choice, freeText=false, option descriptions, open-ended focus, withdrawn copy, and held resumeRequired', async () => {
    const env = setupDomEnv();
    try {
      const container = env.doc.createElement('div');
      const root = createRoot(container as unknown as Element);

      const singleNoFreeText: QuestionRequest = {
        id: '16:strict',
        instanceId: 'pi:hearth',
        sessionId: '16',
        mode: 'async',
        revision: 1,
        status: 'pending',
        multiple: false,
        freeText: false,
        questions: [
          {
            question: 'Choose strategy',
            header: 'Strategy',
            multiple: false,
            custom: false,
            options: [
              { label: 'Fast', description: 'Skip dry-run checks' },
              { label: 'Safe', description: 'Run full verification' },
            ],
          },
        ],
      };

      const renderStandalone = async (request: QuestionRequest) => {
        await React.act(async () => {
          root.render(
            <TooltipProvider>
              <QuestionAnswerComposer
                request={request}
                followups={[]}
                sessionId="16"
                hostLabel="Kiln"
                pendingCount={1}
                pendingIndex={0}
                onPrevious={() => {}}
                onNext={() => {}}
                onBackToChat={() => {}}
                onAnswer={async () => true}
              />
            </TooltipProvider>
          );
        });
      };

      await renderStandalone(singleNoFreeText);
      // Hides note textarea when freeText === false and renders option descriptions.
      expect(findElements(container, (el) => el.tagName === 'TEXTAREA')).toHaveLength(0);
      expect(textContentOf(container)).toContain('Skip dry-run checks');
      expect(textContentOf(container)).toContain('Run full verification');

      const fastBtn = () =>
        findElements(
          container,
          (el) => el.tagName === 'BUTTON' && textContentOf(el).includes('Fast')
        )[0];
      const safeBtn = () =>
        findElements(
          container,
          (el) => el.tagName === 'BUTTON' && textContentOf(el).includes('Safe')
        )[0];

      await React.act(async () => {
        (reactPropsOf(fastBtn()).onClick as () => void)();
      });
      expect(fastBtn().getAttribute('aria-pressed')).toBe('true');
      expect(fastBtn().getAttribute('class')).toContain('border-highlight');

      await React.act(async () => {
        (reactPropsOf(safeBtn()).onClick as () => void)();
      });
      expect(fastBtn().getAttribute('aria-pressed')).toBe('false');
      expect(safeBtn().getAttribute('aria-pressed')).toBe('true');

      // Withdrawn question disables choices, offers Copy answer, and hides Send/Retry.
      await renderStandalone({ ...singleNoFreeText, status: 'withdrawn' });
      expect(safeBtn().getAttribute('disabled')).not.toBeNull();
      expect(
        findElements(
          container,
          (el) => el.tagName === 'BUTTON' && textContentOf(el).includes('Copy answer')
        )
      ).toHaveLength(1);
      expect(
        findElements(
          container,
          (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Send answer'
        )
      ).toHaveLength(0);

      // Held resumeRequired answer shows holdReason clearly.
      await renderStandalone({
        ...singleNoFreeText,
        status: 'answered',
        answer: 'Safe',
        resumeRequired: true,
        delivery: {
          requestId: 'd1',
          status: 'held',
          holdReason: 'The origin conversation was stopped.',
        },
      });
      expect(textContentOf(container)).toContain('Sent · held on the host');
      expect(textContentOf(container)).toContain('The origin conversation was stopped.');

      await React.act(async () => {
        root.unmount();
      });
    } finally {
      env.restore();
    }
  });

  test('unlocks Additional context immediately after canonical poll confirmation while original HTTP response is held', async () => {
    const env = setupDomEnv();
    try {
      const container = env.doc.createElement('div');
      const root = createRoot(container as unknown as Element);

      const pendingReq: QuestionRequest = {
        id: '81:nested:decision',
        instanceId: 'pi:hearth',
        sessionId: '81',
        sourceTitle: 'Backup audit',
        mode: 'async',
        revision: 3,
        status: 'pending',
        questions: [
          {
            question: 'Keep the migration backup?',
            header: 'Backup',
            options: [{ label: 'Keep', description: '' }, { label: 'Remove', description: '' }],
          },
        ],
      };

      let releaseResponse: (() => void) | null = null;
      let capturedMutation: QuestionRequest['mutation'] | undefined;
      const renderComposer = async (request: QuestionRequest) => {
        await React.act(async () => {
          root.render(
            <TooltipProvider>
              <QuestionAnswerComposer
                request={request}
                followups={[]}
                sessionId="16"
                hostLabel="Kiln"
                pendingCount={1}
                pendingIndex={0}
                onPrevious={() => {}}
                onNext={() => {}}
                onBackToChat={() => {}}
                onAnswer={async (req) => {
                  capturedMutation = req.mutation;
                  await new Promise<void>((resolve) => {
                    releaseResponse = resolve;
                  });
                  return true;
                }}
              />
            </TooltipProvider>
          );
        });
      };

      await renderComposer(pendingReq);
      const keepBtn = findElements(
        container,
        (el) => el.tagName === 'BUTTON' && textContentOf(el).includes('Keep')
      )[0];
      await React.act(async () => {
        (reactPropsOf(keepBtn).onClick as () => void)();
      });
      const sendBtn = findElements(
        container,
        (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Send answer'
      )[0];
      await React.act(async () => {
        void (reactPropsOf(sendBtn).onClick as () => Promise<void>)();
      });

      // Canonical poll confirms receipt before the HTTP call resolves.
      await renderComposer({
        ...pendingReq,
        status: 'answered',
        answer: 'Keep',
        receipt: {
          requestId: capturedMutation!.requestId,
          revision: 3,
          answer: 'Keep',
          at: 2000,
        },
      });

      const addContextBtn = findElements(
        container,
        (el) => el.tagName === 'BUTTON' && textContentOf(el).includes('Add more context')
      )[0];
      expect(addContextBtn).toBeDefined();
      await React.act(async () => {
        (reactPropsOf(addContextBtn).onClick as () => void)();
      });

      const contextInput = findElements(
        container,
        (el) => el.tagName === 'TEXTAREA' && el.getAttribute('aria-label') === 'Additional context'
      )[0];
      expect(contextInput).toBeDefined();
      expect(contextInput.getAttribute('disabled')).toBeNull();

      await React.act(async () => {
        contextInput.value = 'Draft started while old HTTP response is held';
        (reactPropsOf(contextInput).onChange as (e: unknown) => void)({
          target: contextInput,
          currentTarget: contextInput,
        });
      });

      // Release late original HTTP response: must NOT erase the new Additional context draft.
      await React.act(async () => {
        releaseResponse?.();
      });
      expect(contextInput.value).toBe('Draft started while old HTTP response is held');
      const sendContextBtn = findElements(
        container,
        (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Send answer'
      )[0];
      expect(sendContextBtn.getAttribute('disabled')).toBeNull();

      await React.act(async () => {
        root.unmount();
      });
    } finally {
      env.restore();
    }
  });
});
