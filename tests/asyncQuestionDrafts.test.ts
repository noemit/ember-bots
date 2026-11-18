import { describe, expect, test } from 'bun:test';
import {
  createQuestionDraftStore,
  questionFailureRecovery,
  unlockQuestionDraft,
  type AsyncQuestionDraft,
} from '../src/lib/asyncQuestionDrafts';
import { piQuestionToQuestionRequest } from '../src/lib/piMapping';
import type { QuestionRequest } from '../src/types';

test('moving a question into history preserves its in-flight draft and notifies a newly mounted row', () => {
  const store = createQuestionDraftStore();
  let oldRow = 0, historyRow = 0;
  const leave = store.subscribe('host:question', () => oldRow++);
  store.put('host:question', { text: 'Keep the original draft', mutation: { requestId: 'send', revision: 1, action: 'answer' } });
  leave();
  store.subscribe('host:question', () => historyRow++);
  store.settle('host:question', 'send', { ...store.get('host:question'), failed: true });
  expect(oldRow).toBe(1); expect(historyRow).toBe(1);
  expect(store.get('host:question')).toMatchObject({ text: 'Keep the original draft', failed: true });
});

test('an old operation cannot clear or replace the next context draft after its receipt arrived', () => {
  const store = createQuestionDraftStore();
  store.put('question', { text: 'Answer', mutation: { requestId: 'old-send', revision: 1 } });
  expect(store.settle('question', 'old-send', { text: '', accepted: 'Answer' })).toBe(true);
  store.put('question', { text: 'The human is writing more context', adding: true, accepted: 'Answer' });
  expect(store.settle('question', 'old-send', { text: '' })).toBe(false);
  expect(store.get('question').text).toBe('The human is writing more context');
});

test('question identity scopes drafts and empty snapshots remain stable for React subscribers', () => {
  const store = createQuestionDraftStore();
  expect(store.get('unknown')).toBe(store.get('unknown'));
  store.put('host-one:question', { text: 'First host' });
  expect(store.get('host-two:question').text).toBe('');
  store.put('host-one:question');
  expect(store.get('host-one:question').text).toBe('');
});

const baseQuestion = (overrides: Partial<QuestionRequest> = {}): QuestionRequest => ({
  ...piQuestionToQuestionRequest('host', {
    conversationId: '81',
    key: 'call:part:3',
    question: 'Keep backup?',
    options: ['Keep', 'Remove'],
    mode: 'async',
    revision: 3,
    status: 'pending',
  }),
  ...overrides,
});

describe('same-revision failure recovery and draft unlock', () => {
  test('same-revision answer failure offers Retry and Edit draft, and unlocking keeps text for fresh editing', () => {
    const request = baseQuestion({ revision: 3, status: 'pending' });
    const failedDraft: AsyncQuestionDraft = {
      text: 'Kepe',
      mutation: { requestId: 'ans-1', revision: 3, action: 'answer' },
      failed: true,
    };
    const recovery = questionFailureRecovery(request, failedDraft, 'Tower');
    expect(recovery).not.toBeNull();
    expect(recovery?.retryAction).toBe('answer');
    expect(recovery?.unlockLabel).toBe('Edit draft');
    expect(recovery?.message).toContain('Tower');
    expect(recovery?.message).toContain('Your text is kept here');
    expect(recovery?.message).toMatch(/Retry.*Edit draft/);

    // Default revision (undefined on request, 1 on mutation) is also treated as same-revision.
    const unversioned = questionFailureRecovery(
      baseQuestion({ revision: undefined }),
      { text: 'Keep', mutation: { requestId: 'ans-2', revision: 1, action: 'answer' }, failed: true },
      'Tower'
    );
    expect(unversioned?.unlockLabel).toBe('Edit draft');

    const unlocked = unlockQuestionDraft(failedDraft, { pending: true });
    expect(unlocked).toEqual({ text: 'Kepe', adding: false });
    expect(unlocked?.mutation).toBeUndefined();
    expect(unlocked?.failed).toBeUndefined();
  });

  test('same-revision context failure offers Retry and Edit draft and preserves adding mode on unlock', () => {
    const request = baseQuestion({
      revision: 4,
      status: 'answered',
      answer: 'Keep',
      receipt: { requestId: 'orig', revision: 3, answer: 'Keep', at: 10 },
    });
    const failedDraft: AsyncQuestionDraft = {
      text: 'Keep until migration verification completes.',
      accepted: 'Keep',
      adding: true,
      mutation: { requestId: 'ctx-1', revision: 4, action: 'context' },
      failed: true,
    };
    const recovery = questionFailureRecovery(request, failedDraft, 'Tower');
    expect(recovery).not.toBeNull();
    expect(recovery?.retryAction).toBe('context');
    expect(recovery?.unlockLabel).toBe('Edit draft');
    expect(recovery?.message).toContain('Tower');

    const unlocked = unlockQuestionDraft(failedDraft, { pending: false, sentAnswer: 'Keep' });
    expect(unlocked).toEqual({
      text: 'Keep until migration verification completes.',
      adding: true,
      accepted: 'Keep',
    });
    expect(unlocked?.mutation).toBeUndefined();
    expect(unlocked?.failed).toBeUndefined();
  });

  test('same-revision withdraw failure uses withdrawal-specific copy without claiming text is kept, and Cancel clears the lock', () => {
    const request = baseQuestion({ revision: 3, status: 'pending' });
    const failedWithdraw: AsyncQuestionDraft = {
      text: '',
      mutation: { requestId: 'wd-1', revision: 3, action: 'withdraw' },
      failed: true,
    };
    const recovery = questionFailureRecovery(request, failedWithdraw, 'Tower');
    expect(recovery).not.toBeNull();
    expect(recovery?.retryAction).toBe('withdraw');
    expect(recovery?.unlockLabel).toBe('Cancel');
    expect(recovery?.message).toContain('Tower');
    expect(recovery?.message).toMatch(/withdrawing/i);
    expect(recovery?.message).toMatch(/Retry.*Cancel/);
    expect(recovery?.message).not.toContain('Your text is kept here');

    // Empty withdraw cancels back to undefined so the draft store deletes its entry cleanly.
    expect(unlockQuestionDraft(failedWithdraw, { pending: true })).toBeUndefined();

    // If the human had typed text before trying to withdraw, Cancel keeps that text while unlocking.
    const withTypedDraft = unlockQuestionDraft(
      { ...failedWithdraw, text: 'Draft before withdraw' },
      { pending: true }
    );
    expect(withTypedDraft).toEqual({ text: 'Draft before withdraw' });
  });

  test('preserves 409 answerConflict and revision-mismatch Edit this draft behavior, and hides failure while busy', () => {
    const conflictRequest = baseQuestion({
      revision: 4,
      status: 'answered',
      answer: 'Keep',
      receipt: { requestId: 'other-human', revision: 3, answer: 'Keep', at: 20 },
    });
    const failedAnswer: AsyncQuestionDraft = {
      text: 'Remove',
      mutation: { requestId: 'my-attempt', revision: 3, action: 'answer' },
      failed: true,
    };
    const conflict = questionFailureRecovery(conflictRequest, failedAnswer, 'Tower');
    expect(conflict).toEqual({
      message: 'Tower already has an answer to this question. Your draft was not sent; you can keep it as more context below.',
      retryAction: null,
      unlockLabel: 'Keep this draft as more context',
    });
    expect(unlockQuestionDraft(failedAnswer, { pending: false, sentAnswer: 'Keep' })).toEqual({
      text: 'Remove',
      adding: true,
      accepted: 'Keep',
    });

    const revisedPending = questionFailureRecovery(
      baseQuestion({ revision: 5, status: 'pending' }),
      failedAnswer,
      'Tower'
    );
    expect(revisedPending?.retryAction).toBe('answer');
    expect(revisedPending?.unlockLabel).toBe('Edit this draft');

    expect(questionFailureRecovery(conflictRequest, failedAnswer, 'Tower', true)).toBeNull();
  });

  test('all failure copy names the actor, offers an on-screen action, and avoids shouting or jargon', () => {
    const cases = [
      questionFailureRecovery(baseQuestion(), { text: 'Keep', mutation: { requestId: '1', revision: 3, action: 'answer' }, failed: true }, ''),
      questionFailureRecovery(baseQuestion({ status: 'answered', revision: 4 }), { text: 'Extra', adding: true, mutation: { requestId: '2', revision: 4, action: 'context' }, failed: true }, 'Tower'),
      questionFailureRecovery(baseQuestion(), { text: '', mutation: { requestId: '3', revision: 3, action: 'withdraw' }, failed: true }, 'Tower'),
      questionFailureRecovery(baseQuestion({ status: 'answered', revision: 4, receipt: { requestId: 'other', revision: 3, answer: 'Keep', at: 1 } }), { text: 'Remove', mutation: { requestId: '4', revision: 3, action: 'answer' }, failed: true }, 'Tower'),
    ];
    for (const recovery of cases) {
      expect(recovery).not.toBeNull();
      const text = recovery!.message;
      expect(text).toMatch(/Kiln|Tower/);
      expect(text).toMatch(/Retry|Cancel|Edit|keep it as more context/);
      expect(text).not.toContain('!');
      expect(text).not.toMatch(/\b(4\d\d|5\d\d|undefined|null|error:|agents?)\b/i);
    }
  });
});
