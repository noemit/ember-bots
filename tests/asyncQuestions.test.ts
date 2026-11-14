import { describe, expect, test } from 'bun:test';
import { isAsyncQuestion, questionsForSupervisor, questionStatusLabel, questionSupervisor } from '../src/lib/asyncQuestions';
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
  test('answer acceptance cannot imply placement, seeing, or execution', () => {
    const answered: QuestionRequest = { ...nested, status: 'answered' };
    expect(questionStatusLabel(answered)).toContain('not yet confirmed');
    expect(questionStatusLabel({ ...answered, delivery: { requestId: 'r', status: 'held' } })).toContain('held');
    expect(questionStatusLabel({ ...answered, delivery: { requestId: 'r', status: 'admitted' } })).toContain('not yet confirmed seen');
    expect(questionStatusLabel({ ...answered, delivery: { requestId: 'r', status: 'seen' } })).toContain('seen by');
  });
});
