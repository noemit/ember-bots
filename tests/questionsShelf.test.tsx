import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import QuestionsShelf, { QuestionComposer, submitQuestionAnswer } from '../src/components/QuestionsShelf';
import { questionDrafts, unlockQuestionDraft } from '../src/lib/asyncQuestionDrafts';
import { piQuestionToQuestionRequest } from '../src/lib/piMapping';
import { questionKey } from '../src/lib/threadQuestions';
import type { QuestionRequest } from '../src/types';

const ensureRenderableGlobals = () => {
  const scope = globalThis as { window?: Record<string, unknown> };
  const current = scope.window ?? {};
  if (typeof current.addEventListener === 'function') return;
  scope.window = {
    ...current,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
};

const pendingQuestion = (overrides: Partial<QuestionRequest> = {}): QuestionRequest => ({
  ...piQuestionToQuestionRequest('pi:tower', {
    conversationId: '81',
    key: 'nested:decision',
    question: 'Keep the migration backup?',
    options: ['Keep', 'Remove'],
    mode: 'async',
    revision: 3,
    status: 'pending',
  }),
  ...overrides,
});

const touchedKeys = new Set<string>();
const putDraft = (request: QuestionRequest, draft?: Parameters<typeof questionDrafts.put>[1]) => {
  const key = questionKey(request);
  touchedKeys.add(key);
  questionDrafts.put(key, draft);
};

afterEach(() => {
  for (const key of touchedKeys) questionDrafts.put(key, undefined);
  touchedKeys.clear();
});

const renderShelf = (requests: QuestionRequest[], hostLabel = 'Tower') => {
  ensureRenderableGlobals();
  return renderToStaticMarkup(
    <QuestionsShelf
      hostLabel={hostLabel}
      requests={requests}
      sessionId="16"
      onAnswer={async () => false}
    />
  );
};

const hasDisabledAttr = (attrs: string) => /\sdisabled(?:=|\s|$)/.test(attrs);

const buttonsIn = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({
    attrs: match[1],
    label: match[2].replace(/<[^>]+>/g, '').trim(),
    disabled: hasDisabledAttr(match[1]),
  }));

const textareaDisabled = (html: string) => {
  const match = html.match(/<textarea\b([^>]*)>/);
  return match ? hasDisabledAttr(match[1]) : null;
};

describe('QuestionsShelf failed-mutation lockout recovery', () => {
  test('same-revision failed answer renders Retry and Edit draft, and unlocking re-enables options, textarea, Send, and Withdraw', () => {
    const request = pendingQuestion({ revision: 3 });
    putDraft(request, {
      text: 'Kepe',
      mutation: { requestId: 'ans-net-fail', revision: 3, action: 'answer' },
      failed: true,
    });

    const lockedHtml = renderShelf([request]);
    expect(lockedHtml).toContain('role="alert"');
    expect(lockedHtml).toContain('Tower did not confirm this change. Your text is kept here.');
    expect(textareaDisabled(lockedHtml)).toBe(true);

    const lockedButtons = buttonsIn(lockedHtml);
    expect(lockedButtons.find((b) => b.label === 'Keep')?.disabled).toBe(true);
    expect(lockedButtons.find((b) => b.label === 'Remove')?.disabled).toBe(true);
    expect(lockedButtons.find((b) => b.label === 'Send')?.disabled).toBe(true);
    expect(lockedButtons.find((b) => b.label === 'Withdraw question')).toBeUndefined();
    expect(lockedButtons.find((b) => b.label === 'Retry')?.disabled).toBe(false);
    expect(lockedButtons.find((b) => b.label === 'Edit draft')?.disabled).toBe(false);

    // Clicking Edit draft clears mutation/failed while preserving text on the pending question.
    putDraft(request, unlockQuestionDraft(questionDrafts.get(questionKey(request)), { pending: true }));

    const unlockedHtml = renderShelf([request]);
    expect(unlockedHtml).not.toContain('role="alert"');
    expect(unlockedHtml).toContain('>Kepe</textarea>');
    expect(textareaDisabled(unlockedHtml)).toBe(false);

    const unlockedButtons = buttonsIn(unlockedHtml);
    expect(unlockedButtons.find((b) => b.label === 'Keep')?.disabled).toBe(false);
    expect(unlockedButtons.find((b) => b.label === 'Remove')?.disabled).toBe(false);
    expect(unlockedButtons.find((b) => b.label === 'Send')?.disabled).toBe(false);
    expect(unlockedButtons.find((b) => b.label === 'Withdraw question')?.disabled).toBe(false);
  });

  test('same-revision failed context renders Retry and Edit draft, and unlocking keeps the context composer open and editable', () => {
    const request = pendingQuestion({
      revision: 4,
      status: 'answered',
      answer: 'Keep',
      receipt: { requestId: 'orig', revision: 3, answer: 'Keep', at: 10 },
    });
    putDraft(request, {
      text: 'Keep until verification finishes.',
      accepted: 'Keep',
      adding: true,
      mutation: { requestId: 'ctx-net-fail', revision: 4, action: 'context' },
      failed: true,
    });

    const lockedHtml = renderShelf([request]);
    expect(lockedHtml).toContain('role="alert"');
    expect(textareaDisabled(lockedHtml)).toBe(true);

    const lockedButtons = buttonsIn(lockedHtml);
    expect(lockedButtons.find((b) => b.label === 'Send')?.disabled).toBe(true);
    expect(lockedButtons.find((b) => b.label === 'Retry')?.disabled).toBe(false);
    expect(lockedButtons.find((b) => b.label === 'Edit draft')?.disabled).toBe(false);
    expect(lockedButtons.find((b) => b.label === 'Keep this draft as more context')).toBeUndefined();

    // Clicking Edit draft clears mutation/failed while keeping draft.text and adding: true.
    putDraft(
      request,
      unlockQuestionDraft(questionDrafts.get(questionKey(request)), { pending: false, sentAnswer: 'Keep' })
    );

    const unlockedHtml = renderShelf([request]);
    expect(unlockedHtml).not.toContain('role="alert"');
    expect(unlockedHtml).toContain('>Keep until verification finishes.</textarea>');
    expect(textareaDisabled(unlockedHtml)).toBe(false);
    expect(buttonsIn(unlockedHtml).find((b) => b.label === 'Send')?.disabled).toBe(false);
  });

  test('same-revision failed withdraw renders withdrawal-specific copy with Retry and Cancel, and Cancel unlocks answering', () => {
    const request = pendingQuestion({ revision: 3 });
    putDraft(request, {
      text: '',
      mutation: { requestId: 'wd-net-fail', revision: 3, action: 'withdraw' },
      failed: true,
    });

    const lockedHtml = renderShelf([request]);
    expect(lockedHtml).toContain('role="alert"');
    expect(lockedHtml).toContain('Tower did not confirm withdrawing this question');
    expect(lockedHtml).not.toContain('Your text is kept here');
    expect(textareaDisabled(lockedHtml)).toBe(true);

    const lockedButtons = buttonsIn(lockedHtml);
    expect(lockedButtons.find((b) => b.label === 'Keep')?.disabled).toBe(true);
    expect(lockedButtons.find((b) => b.label === 'Retry')?.disabled).toBe(false);
    expect(lockedButtons.find((b) => b.label === 'Cancel')?.disabled).toBe(false);
    expect(lockedButtons.find((b) => b.label === 'Edit draft')).toBeUndefined();

    // Clicking Cancel clears the failed withdraw mutation so the human can answer or edit again.
    putDraft(request, unlockQuestionDraft(questionDrafts.get(questionKey(request)), { pending: true }));

    const unlockedHtml = renderShelf([request]);
    expect(unlockedHtml).not.toContain('role="alert"');
    expect(textareaDisabled(unlockedHtml)).toBe(false);
    const unlockedButtons = buttonsIn(unlockedHtml);
    expect(unlockedButtons.find((b) => b.label === 'Keep')?.disabled).toBe(false);
    expect(unlockedButtons.find((b) => b.label === 'Withdraw question')?.disabled).toBe(false);
  });

  test('preserves 409 answerConflict Keep this draft as more context and revision-mismatch Edit this draft', () => {
    const conflictRequest = pendingQuestion({
      revision: 4,
      status: 'answered',
      answer: 'Keep',
      receipt: { requestId: 'other-answer', revision: 3, answer: 'Keep', at: 10 },
    });
    putDraft(conflictRequest, {
      text: 'Remove',
      mutation: { requestId: 'my-answer', revision: 3, action: 'answer' },
      failed: true,
    });

    const conflictHtml = renderShelf([conflictRequest]);
    const conflictButtons = buttonsIn(conflictHtml);
    expect(conflictHtml).toContain('Tower already has an answer to this question.');
    expect(conflictButtons.find((b) => b.label === 'Retry')).toBeUndefined();
    expect(conflictButtons.find((b) => b.label === 'Keep this draft as more context')?.disabled).toBe(false);

    const revisedRequest = pendingQuestion({ revision: 5, status: 'pending' });
    putDraft(revisedRequest, {
      text: 'Keep',
      mutation: { requestId: 'my-answer', revision: 3, action: 'answer' },
      failed: true,
    });
    const revisedHtml = renderShelf([revisedRequest]);
    const revisedButtons = buttonsIn(revisedHtml);
    expect(revisedButtons.find((b) => b.label === 'Retry')?.disabled).toBe(false);
    expect(revisedButtons.find((b) => b.label === 'Edit this draft')?.disabled).toBe(false);
  });
});

const pendingRequest: QuestionRequest = {
  id: '81:decision',
  instanceId: 'pi:local',
  sessionId: '81',
  mode: 'async',
  revision: 1,
  status: 'pending',
  sourceTitle: 'Backup audit',
  questions: [
    {
      question: 'Keep the migration backup?',
      header: 'Backup',
      options: [
        { label: 'Keep', description: 'Keep backup' },
        { label: 'Remove', description: 'Remove backup' },
      ],
    },
  ],
};

const answeredRequest: QuestionRequest = {
  id: '81:previous',
  instanceId: 'pi:local',
  sessionId: '81',
  mode: 'async',
  revision: 1,
  status: 'answered',
  answer: 'Yes, dry run first.',
  updatedAt: 100,
  sourceTitle: 'Backup audit',
  questions: [
    {
      question: 'Use a dry run first?',
      header: 'Dry run',
      options: [],
    },
  ],
};

afterEach(() => {
  questionDrafts.put(questionKey(pendingRequest));
  questionDrafts.put(questionKey(answeredRequest));
});

const findTextarea = (node: unknown): React.ReactElement<React.ComponentProps<'textarea'>> | null => {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTextarea(child);
      if (found) return found;
    }
    return null;
  }
  const element = node as { type?: unknown; props?: { children?: unknown } };
  if (element.type === 'textarea') {
    return element as unknown as React.ReactElement<React.ComponentProps<'textarea'>>;
  }
  return findTextarea(element.props?.children);
};

describe('QuestionsShelf button spacing, keyboard submit, and failed-send history guard', () => {
  test('wraps Send and Withdraw question in a flex gap container without standalone mt-2 on child buttons', () => {
    ensureRenderableGlobals();
    questionDrafts.put(questionKey(pendingRequest), { text: 'Keep' });

    const html = renderToStaticMarkup(
      <QuestionsShelf
        requests={[pendingRequest, answeredRequest]}
        sessionId="16"
        onAnswer={async () => true}
      />
    );

    const containerMatch = html.match(
      /<div class="mt-2 flex flex-wrap items-center gap-2">([\s\S]*?)<\/div>/
    );
    expect(containerMatch).not.toBeNull();
    const containerInner = containerMatch![1];
    expect(containerInner).toContain('>Send</button>');
    expect(containerInner).toContain('>Withdraw question</button>');
    for (const buttonTag of [...containerInner.matchAll(/<button\b[^>]*>/g)].map((m) => m[0])) {
      expect(buttonTag).not.toContain('mt-2');
    }

    // History stays folded on initial render.
    expect(html).toContain('Answered and closed (1)');
    expect(html).not.toMatch(/<details[^>]*\bopen\b[^>]*>\s*<summary[^>]*>Answered and closed/);
  });

  test('keeps the action wrapper when appending follow-up context on an answered question', () => {
    ensureRenderableGlobals();
    questionDrafts.put(questionKey(answeredRequest), {
      text: 'Extra context after review',
      accepted: 'Yes, dry run first.',
      adding: true,
    });

    const html = renderToStaticMarkup(
      <QuestionsShelf
        requests={[answeredRequest]}
        sessionId="16"
        onAnswer={async () => true}
      />
    );

    const containerMatch = html.match(
      /<div class="mt-2 flex flex-wrap items-center gap-2">([\s\S]*?)<\/div>/
    );
    expect(containerMatch).not.toBeNull();
    expect(containerMatch![1]).toContain('>Send</button>');
    expect(containerMatch![1]).not.toContain('Withdraw question');
  });

  test('Mod+Enter (Ctrl+Enter / Cmd+Enter) on textarea submits answer when pending and context when adding', () => {
    const submitted: Array<'answer' | 'context'> = [];

    const renderComposer = (overrides: Partial<React.ComponentProps<typeof QuestionComposer>> = {}) => {
      const tree = QuestionComposer({
        id: 'q1',
        question: 'Keep the migration backup?',
        options: [{ label: 'Keep' }],
        text: 'Keep until verified',
        pending: true,
        busy: false,
        disabled: false,
        hasMutation: false,
        onSelectOption: () => {},
        onTextChange: () => {},
        onSubmit: (action) => submitted.push(action),
        onWithdraw: () => {},
        ...overrides,
      });
      const textarea = findTextarea(tree);
      expect(textarea).not.toBeNull();
      return textarea!;
    };

    // Ctrl+Enter while pending -> submits 'answer' and prevents default.
    let prevented = false;
    renderComposer({ pending: true }).props.onKeyDown!({
      key: 'Enter',
      ctrlKey: true,
      metaKey: false,
      preventDefault: () => { prevented = true; },
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    expect(prevented).toBe(true);
    expect(submitted).toEqual(['answer']);

    // Cmd+Enter while adding context (pending: false) -> submits 'context' and prevents default.
    prevented = false;
    renderComposer({ pending: false }).props.onKeyDown!({
      key: 'Enter',
      ctrlKey: false,
      metaKey: true,
      preventDefault: () => { prevented = true; },
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    expect(prevented).toBe(true);
    expect(submitted).toEqual(['answer', 'context']);

    // Plain Enter inserts a newline rather than submitting.
    prevented = false;
    renderComposer({ pending: true }).props.onKeyDown!({
      key: 'Enter',
      ctrlKey: false,
      metaKey: false,
      preventDefault: () => { prevented = true; },
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    expect(prevented).toBe(false);
    expect(submitted).toHaveLength(2);

    // Whitespace-only draft or disabled textarea never submits on Mod+Enter.
    for (const ignored of [
      { text: '   ', disabled: false },
      { text: 'Keep', disabled: true },
    ]) {
      prevented = false;
      renderComposer(ignored).props.onKeyDown!({
        key: 'Enter',
        ctrlKey: true,
        metaKey: false,
        preventDefault: () => { prevented = true; },
      } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
      expect(prevented).toBe(false);
      expect(submitted).toHaveLength(2);
    }
  });

  test('only opens Answered and closed history when onAnswer resolves true', async () => {
    let historyOpened = 0;

    const failedResult = await submitQuestionAnswer(
      async () => false,
      pendingRequest,
      [['Keep']],
      () => { historyOpened += 1; }
    );
    expect(failedResult).toBe(false);
    expect(historyOpened).toBe(0);

    await expect(
      submitQuestionAnswer(
        async () => { throw new Error('network down'); },
        pendingRequest,
        [['Keep']],
        () => { historyOpened += 1; }
      )
    ).rejects.toThrow('network down');
    expect(historyOpened).toBe(0);

    const okResult = await submitQuestionAnswer(
      async () => true,
      pendingRequest,
      [['Keep']],
      () => { historyOpened += 1; }
    );
    expect(okResult).toBe(true);
    expect(historyOpened).toBe(1);
  });
});
