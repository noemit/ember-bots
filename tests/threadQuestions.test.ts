import { describe, expect, test } from 'bun:test';
import { crewByLeader, threadDescendants } from '../src/lib/crew';
import { questionKey, questionsFromThreads } from '../src/lib/threadQuestions';
import type { QuestionRequest, Session } from '../src/types';

const leader: Session = { id: 'leader', instanceId: 'one' };
const worker = (id: string, parent: string, instanceId = 'one'): Session => ({
  id, instanceId, kind: 'worker', title: id, directory: `/work/${id}`,
  lead: { instanceId, sessionId: parent },
});
const question = (sessionId: string, instanceId = 'one'): QuestionRequest => ({
  id: 'same-form', instanceId, sessionId, directory: `/work/${sessionId}`,
  questions: [{ question: 'Proceed?', options: [] }],
});

describe('pending thread questions', () => {
  const direct = worker('direct', leader.id);
  const nested = worker('nested', direct.id);
  const elsewhere = worker('elsewhere', 'another');
  const otherHost = worker('direct', leader.id, 'two');
  const peer = { ...worker('peer', leader.id), kind: 'peer' as const };
  const sessions = [leader, direct, nested, elsewhere, otherHost, peer];
  const descendants = threadDescendants(leader, crewByLeader(sessions));

  test('includes direct and nested pending questions without relying on summary needsInput', () => {
    const requests = [question('direct'), question('nested')];
    const result = questionsFromThreads(descendants, requests);
    expect(result.map((entry) => entry.source.id)).toEqual(['direct', 'nested']);
    expect(result[0].request).toBe(requests[0]); // No rewritten origin, directory or form fields.
    expect(result[1].request).toBe(requests[1]);
  });

  test('excludes leader, other families, peers and same ids on another host; de-duplicates only exact identity', () => {
    const requests = [question('leader'), question('direct'), question('nested'),
      question('elsewhere'), question('direct', 'two'), question('peer'), question('direct')];
    expect(questionsFromThreads(descendants, requests).map((entry) => questionKey(entry.request)))
      .toEqual([questionKey(question('direct')), questionKey(question('nested'))]);
    const secondLeader = { ...leader, instanceId: 'two' };
    expect(questionsFromThreads(threadDescendants(secondLeader, crewByLeader(sessions)), requests)
      .map((entry) => entry.request.instanceId)).toEqual(['two']);
  });

  test('answer/cancel removes only that source request, and a summary alone never invents a card', () => {
    const requests = [question('direct'), question('nested'), question('direct', 'two')];
    const remaining = requests.filter((entry) => questionKey(entry) !== questionKey(requests[0]));
    expect(remaining).toHaveLength(2);
    expect(questionsFromThreads(descendants, remaining).map((entry) => entry.source.id)).toEqual(['nested']);
    expect(questionsFromThreads([{ ...direct, needsInput: true }], [])).toEqual([]);
  });

  test('cycles cannot duplicate questions or surface the leader as its own thread', () => {
    const cycle = [{ ...leader, kind: 'worker' as const, lead: { instanceId: 'one', sessionId: 'nested' } }, direct, nested];
    expect(questionsFromThreads(threadDescendants(cycle[0], crewByLeader(cycle)),
      [question('leader'), question('direct'), question('nested')])).toHaveLength(2);
  });
});
