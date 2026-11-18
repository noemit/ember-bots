import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import QuestionsShelf, { QuestionComposer, submitQuestionAnswer } from '../src/components/QuestionsShelf';
import { questionDrafts } from '../src/lib/asyncQuestionDrafts';
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
