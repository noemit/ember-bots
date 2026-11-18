import { describe, expect, test } from 'bun:test';
import {
  allowsMultipleQuestionChoices,
  composeQuestionAnswer,
  formatQuestionAnswerForRequest,
  isAsyncQuestion,
  isLongQuestionContext,
  questionMutationConfirmed,
  questionFollowups,
  questionRecipientLabel,
  questionSourceMessage,
  questionsForSupervisor,
  questionStatusLabel,
  questionSupervisor,
} from '../src/lib/asyncQuestions';
import { piQuestionToQuestionRequest } from '../src/lib/piMapping';
import type { QuestionRequest } from '../src/types';

const nested = piQuestionToQuestionRequest('host', { conversationId: '81', key: 'call:part:3', question: 'Keep backup?', mode: 'async', revision: 3, status: 'pending', ancestry: [{ conversationId: '18', title: 'Supervisor' }, { conversationId: '16', title: 'Root' }], context: 'Migration', recommendation: 'Keep', source: 'e810', origin: { conversationId: '81', taskOwnerId: '18', taskKey: 'audit', assignmentVersion: '81:1' } });
describe('async Questions inbox policy', () => {
  test('unknown nested source is reachable from every supervisory ancestor, not unrelated chats or hosts', () => {
    expect(questionsForSupervisor({ id: '16', instanceId: 'host' }, [nested])).toEqual([nested]);
    expect(questionsForSupervisor({ id: '18', instanceId: 'host' }, [nested])).toEqual([nested]);
    expect(questionsForSupervisor({ id: '81', instanceId: 'host' }, [nested])).toEqual([nested]);
    expect(questionsForSupervisor({ id: '17', instanceId: 'host' }, [nested])).toEqual([]);
    expect(questionsForSupervisor({ id: '16', instanceId: 'other' }, [nested])).toEqual([]);
    expect(questionSupervisor(nested, '16')).toBe('Supervisor');
  });
  test('legacy forms remain blocking while structured fields survive mapping', () => {
    expect(isAsyncQuestion({ ...nested, mode: undefined })).toBe(false);
    expect(nested.id).toEndWith('call:part:3');
    expect(nested.origin?.assignmentVersion).toBe('81:1');
    expect(nested.revision).toBe(3);
  });
  test('canonical provenance is required for source navigation and context belongs to one question', () => {
    expect(questionSourceMessage(nested)).toBeUndefined();
    expect(questionSourceMessage({ ...nested, origin: { ...nested.origin!, sourceMessageId: 'e811' } })).toBe('e811');
    expect(questionSourceMessage({ ...nested, origin: { ...nested.origin!, sourceMessageId: '../e811' } })).toBeUndefined();
    expect(questionSourceMessage({ ...nested, origin: { ...nested.origin!, conversationId: 'other', sourceMessageId: 'e811' } })).toBeUndefined();
    const more = { ...nested, id: '81:context', replyTo: 'call:part:3', createdAt: 11 };
    expect(questionFollowups(nested, [more, { ...more, id: 'other:context', instanceId: 'other' }])).toEqual([more]);
  });
  test('answer acceptance cannot imply placement, seeing, or execution', () => {
    const answered: QuestionRequest = { ...nested, status: 'answered' };
    expect(questionStatusLabel(answered)).toContain('not yet confirmed');
    expect(questionStatusLabel({ ...answered, delivery: { requestId: 'r', status: 'held' } })).toContain('held');
    expect(questionStatusLabel({ ...answered, delivery: { requestId: 'r', status: 'admitted' } })).toContain('not yet confirmed seen');
    expect(questionStatusLabel({ ...answered, delivery: { requestId: 'r', status: 'seen' } })).toContain('seen by');
  });
});


test('uncertain replies need an exact receipt on the same host, conversation and question', () => {
  const request: QuestionRequest = { ...nested, mutation: { action: 'context', requestId: 'append', revision: 3 } };
  const accepted: QuestionRequest = { ...nested, id: '81:child', replyTo: 'call:part:3', receipt: { requestId: 'append', revision: 3, answer: 'More context', at: 1 } };
  expect(questionMutationConfirmed(request, [['More context']], [accepted])).toBe(true);
  expect(questionMutationConfirmed(request, [['Other text']], [accepted])).toBe(false);
  expect(questionMutationConfirmed(request, [['More context']], [{ ...accepted, instanceId: 'another-host' }])).toBe(false);
  expect(questionMutationConfirmed(request, [['More context']], [{ ...accepted, replyTo: 'another-question' }])).toBe(false);
  expect(questionMutationConfirmed(request, [['More context']], [{ ...accepted, receipt: { ...accepted.receipt!, requestId: 'another-request' } }])).toBe(false);
  expect(questionStatusLabel({ ...accepted, status: 'answered', delivery: { requestId: 'delivery', status: 'admitted', placement: 'placed' } })).toMatch(/Delivered.*not yet confirmed seen/);
});

test('recipient provenance, choice+note composition, multiplicity, and context length helpers', () => {
  expect(questionRecipientLabel({ ...nested, sessionId: '16' }, '16')).toBe('Answer for this conversation');
  expect(questionRecipientLabel({ ...nested, sourceTitle: 'Backup audit' }, '16')).toBe('Answer for task · Backup audit');
  expect(questionRecipientLabel({ ...nested, sourceTitle: undefined, assignment: undefined }, '16')).toBe('Answer for task · Conversation 81');

  expect(composeQuestionAnswer(['Gradual', 'All at once'], ['All at once', 'Gradual'], '  Check canary metrics.  ')).toBe(
    'Gradual\nAll at once\n\nCheck canary metrics.'
  );
  expect(composeQuestionAnswer(['Keep', 'Remove'], ['Keep'], '   ')).toBe('Keep');
  expect(composeQuestionAnswer([], [], '  Only note\nLine 2  ')).toBe('Only note\nLine 2');
  expect(composeQuestionAnswer(['Keep', 'Remove'], ['Remove'], 'Ignored', false)).toBe('Remove');

  const multiAsync = piQuestionToQuestionRequest('host', {
    conversationId: '81',
    key: 'q1',
    question: 'Choose',
    options: ['A', 'B'],
    mode: 'async',
  });
  expect(allowsMultipleQuestionChoices(multiAsync)).toBe(true);
  expect(formatQuestionAnswerForRequest(multiAsync, ['B', 'A'], ' note ')).toBe('A\nB\n\nnote');

  const singleAsync = piQuestionToQuestionRequest('host', {
    conversationId: '81',
    key: 'q2',
    question: 'Pick one',
    options: ['A', 'B'],
    mode: 'async',
    multiple: false,
  });
  expect(allowsMultipleQuestionChoices(singleAsync)).toBe(false);

  const blocking = piQuestionToQuestionRequest('host', {
    conversationId: '81',
    key: 'q3',
    question: 'Blocking?',
    options: ['Yes', 'No'],
  });
  expect(allowsMultipleQuestionChoices(blocking)).toBe(false);

  expect(isLongQuestionContext(nested)).toBe(false);
  expect(isLongQuestionContext({ ...nested, context: 'Line 1\nLine 2' })).toBe(true);
  expect(isLongQuestionContext({ ...nested, context: 'x'.repeat(145) })).toBe(true);
});
