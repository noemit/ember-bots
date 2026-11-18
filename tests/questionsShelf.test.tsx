import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import QuestionsShelf, { submitQuestionAnswer } from '../src/components/QuestionsShelf';
import QuestionAnswerComposer, {
  submitQuestionMutation,
} from '../src/components/QuestionAnswerComposer';
import { TooltipProvider } from '../src/components/ui/tooltip';
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

const renderAnswerComposer = (
  request: QuestionRequest,
  overrides: Partial<React.ComponentProps<typeof QuestionAnswerComposer>> = {}
) => {
  ensureRenderableGlobals();
  return renderToStaticMarkup(
    <TooltipProvider>
      <QuestionAnswerComposer
        request={request}
        followups={[]}
        sessionId="16"
        hostLabel="Tower"
        pendingCount={1}
        pendingIndex={0}
        onPrevious={() => {}}
        onNext={() => {}}
        onBackToChat={() => {}}
        onAnswer={async () => false}
        {...overrides}
      />
    </TooltipProvider>
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

describe('QuestionsShelf compact context and failed-mutation recovery', () => {
  test('QuestionsShelf renders zero textareas, keeps Answer + Withdraw spaced, and collapses long context behind More context', () => {
    const longContextQuestion = pendingQuestion({
      context: 'Line one of migration context.\n' + 'Additional detailed context. '.repeat(8),
      recommendation: 'Keep until verification completes.',
    });
    const html = renderShelf([longContextQuestion]);
    expect(html).not.toContain('<textarea');
    expect(html).toContain('More context');
    expect(html).not.toContain('Keep until verification completes.');
    const buttons = buttonsIn(html);
    expect(buttons.find((b) => b.label === 'Answer')).toBeDefined();
    expect(buttons.find((b) => b.label === 'Withdraw question')).toBeDefined();
  });

  test('same-revision failed answer renders Retry and Edit draft, and unlocking re-enables options, textarea, Send answer, and Withdraw', () => {
    const request = pendingQuestion({ revision: 3 });
    putDraft(request, {
      text: 'Kepe',
      picked: ['Keep'],
      submitted: 'Keep\n\nKepe',
      mutation: { requestId: 'ans-net-fail', revision: 3, action: 'answer' },
      failed: true,
    });

    const lockedShelf = renderShelf([request]);
    expect(lockedShelf).toContain('role="alert"');
    expect(lockedShelf).toContain('Tower did not confirm this change. Your text is kept here.');
    const lockedShelfButtons = buttonsIn(lockedShelf);
    expect(lockedShelfButtons.find((b) => b.label === 'Withdraw question')).toBeUndefined();
    expect(lockedShelfButtons.find((b) => b.label === 'Retry')?.disabled).toBe(false);
    expect(lockedShelfButtons.find((b) => b.label === 'Edit draft')?.disabled).toBe(false);

    const lockedComposer = renderAnswerComposer(request);
    expect(lockedComposer).toContain('role="alert"');
    expect(textareaDisabled(lockedComposer)).toBe(true);
    const lockedButtons = buttonsIn(lockedComposer);
    expect(lockedButtons.find((b) => b.label === 'Keep')?.disabled).toBe(true);
    expect(lockedButtons.find((b) => b.label === 'Remove')?.disabled).toBe(true);
    expect(lockedButtons.find((b) => b.attrs.includes('aria-label="Send answer"'))?.disabled).toBe(true);
    expect(lockedButtons.find((b) => b.label === 'Retry')?.disabled).toBe(false);
    expect(lockedButtons.find((b) => b.label === 'Edit draft')?.disabled).toBe(false);
    expect(lockedButtons.find((b) => b.label === 'Copy answer')?.disabled).toBe(false);

    // Clicking Edit draft clears mutation/failed while preserving picked choices and note text.
    putDraft(
      request,
      unlockQuestionDraft(questionDrafts.get(questionKey(request)), {
        pending: true,
        optionOrder: ['Keep', 'Remove'],
      })
    );

    const unlockedComposer = renderAnswerComposer(request);
    expect(unlockedComposer).not.toContain('role="alert"');
    expect(unlockedComposer).toContain('>Kepe</textarea>');
    expect(textareaDisabled(unlockedComposer)).toBe(false);

    const unlockedButtons = buttonsIn(unlockedComposer);
    const keepButton = unlockedButtons.find((b) => b.label === 'Keep');
    expect(keepButton?.disabled).toBe(false);
    expect(keepButton?.attrs).toContain('aria-pressed="true"');
    expect(unlockedButtons.find((b) => b.label === 'Remove')?.disabled).toBe(false);
    expect(unlockedButtons.find((b) => b.attrs.includes('aria-label="Send answer"'))?.disabled).toBe(false);

    const unlockedShelfButtons = buttonsIn(renderShelf([request]));
    expect(unlockedShelfButtons.find((b) => b.label === 'Withdraw question')?.disabled).toBe(false);
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

    const lockedHtml = renderAnswerComposer(request);
    expect(lockedHtml).toContain('role="alert"');
    expect(textareaDisabled(lockedHtml)).toBe(true);

    const lockedButtons = buttonsIn(lockedHtml);
    expect(lockedButtons.find((b) => b.attrs.includes('aria-label="Send answer"'))?.disabled).toBe(true);
    expect(lockedButtons.find((b) => b.label === 'Retry')?.disabled).toBe(false);
    expect(lockedButtons.find((b) => b.label === 'Edit draft')?.disabled).toBe(false);
    expect(lockedButtons.find((b) => b.label === 'Keep this draft as more context')).toBeUndefined();

    // Clicking Edit draft clears mutation/failed while keeping draft.text and adding: true.
    putDraft(
      request,
      unlockQuestionDraft(questionDrafts.get(questionKey(request)), { pending: false, sentAnswer: 'Keep' })
    );

    const unlockedHtml = renderAnswerComposer(request);
    expect(unlockedHtml).not.toContain('role="alert"');
    expect(unlockedHtml).toContain('>Keep until verification finishes.</textarea>');
    expect(textareaDisabled(unlockedHtml)).toBe(false);
    expect(buttonsIn(unlockedHtml).find((b) => b.attrs.includes('aria-label="Send answer"'))?.disabled).toBe(false);
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

    const lockedButtons = buttonsIn(lockedHtml);
    expect(lockedButtons.find((b) => b.label === 'Retry')?.disabled).toBe(false);
    expect(lockedButtons.find((b) => b.label === 'Cancel')?.disabled).toBe(false);
    expect(lockedButtons.find((b) => b.label === 'Edit draft')).toBeUndefined();

    const lockedComposer = renderAnswerComposer(request);
    expect(textareaDisabled(lockedComposer)).toBe(true);
    expect(buttonsIn(lockedComposer).find((b) => b.label === 'Keep')?.disabled).toBe(true);

    // Clicking Cancel clears the failed withdraw mutation so the human can answer or edit again.
    putDraft(request, unlockQuestionDraft(questionDrafts.get(questionKey(request)), { pending: true }));

    const unlockedComposer = renderAnswerComposer(request);
    expect(unlockedComposer).not.toContain('role="alert"');
    expect(textareaDisabled(unlockedComposer)).toBe(false);
    expect(buttonsIn(unlockedComposer).find((b) => b.label === 'Keep')?.disabled).toBe(false);
    expect(buttonsIn(renderShelf([request])).find((b) => b.label === 'Withdraw question')?.disabled).toBe(false);
  });

  test('preserves 409 answerConflict Keep this draft as more context and revision-mismatch Edit this draft', () => {
    const conflictRequest = pendingQuestion({
      revision: 4,
      status: 'answered',
      answer: 'Keep',
      receipt: { requestId: 'other-answer', revision: 3, answer: 'Keep', at: 10 },
    });
    putDraft(conflictRequest, {
      text: '',
      picked: ['Remove'],
      submitted: 'Remove',
      mutation: { requestId: 'my-answer', revision: 3, action: 'answer' },
      failed: true,
    });

    const conflictHtml = renderAnswerComposer(conflictRequest);
    const conflictButtons = buttonsIn(conflictHtml);
    expect(conflictHtml).toContain('Tower already has an answer to this question.');
    expect(conflictButtons.find((b) => b.label === 'Retry')).toBeUndefined();
    expect(conflictButtons.find((b) => b.label === 'Keep this draft as more context')?.disabled).toBe(false);
    expect(conflictButtons.find((b) => b.label === 'Copy answer')?.disabled).toBe(false);

    const revisedRequest = pendingQuestion({ revision: 5, status: 'pending' });
    putDraft(revisedRequest, {
      text: '',
      picked: ['Keep'],
      submitted: 'Keep',
      mutation: { requestId: 'my-answer', revision: 3, action: 'answer' },
      failed: true,
    });
    const revisedHtml = renderAnswerComposer(revisedRequest);
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

describe('QuestionsShelf action layout, history fold, and submit helper', () => {
  test('wraps Answer and Withdraw question in a flex gap container without standalone mt-2 on child buttons', () => {
    ensureRenderableGlobals();
    questionDrafts.put(questionKey(pendingRequest), { text: '', picked: ['Keep'] });

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
    expect(containerInner).toContain('>Answer</button>');
    expect(containerInner).toContain('>Withdraw question</button>');
    for (const buttonTag of [...containerInner.matchAll(/<button\b[^>]*>/g)].map((m) => m[0])) {
      expect(buttonTag).not.toContain('mt-2');
    }

    // History stays folded on initial render.
    expect(html).toContain('Answered and closed (1)');
    expect(html).not.toMatch(/<details[^>]*\bopen\b[^>]*>\s*<summary[^>]*>Answered and closed/);
  });

  test('only opens Answered and closed history when onAnswer resolves true', async () => {
    let historyOpened = 0;

    const failedResult = await submitQuestionAnswer(
      async () => false,
      pendingRequest,
      [['Keep']],
      () => {
        historyOpened += 1;
      }
    );
    expect(failedResult).toBe(false);
    expect(historyOpened).toBe(0);

    await expect(
      submitQuestionMutation(
        async () => {
          throw new Error('network down');
        },
        pendingRequest,
        [['Keep']],
        () => {
          historyOpened += 1;
        }
      )
    ).rejects.toThrow('network down');
    expect(historyOpened).toBe(0);

    const okResult = await submitQuestionAnswer(
      async () => true,
      pendingRequest,
      [['Keep']],
      () => {
        historyOpened += 1;
      }
    );
    expect(okResult).toBe(true);
    expect(historyOpened).toBe(1);
  });
});
