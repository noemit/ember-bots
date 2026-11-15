import { describe, expect, test } from 'bun:test';
import { taskIsDone, taskIsUnfinished, taskStatusSignal, threadShelfStatus } from '../src/lib/crew';
import { invalidationsFor } from '../src/lib/invalidation';
import { piConversationToSession } from '../src/lib/piMapping';
import type { Session, WorkerTask } from '../src/types';

const completion = { task: '17:1', summary: 'Ready', evidence: 'tests pass', remaining: 'Manual review', requestId: 'complete-1', at: 1 };
const worker = (status: WorkerTask['status'], extra: Partial<Session> = {}): Session => ({
  id: '17', instanceId: 'host', title: 'Renamed chat', task: { id: '17:1', title: 'Assigned outcome', status }, ...extra,
});

describe('explicit task lifecycle presentation', () => {
  test('assignment changes refresh the lifecycle summary without waiting for a final reply', () => {
    for (const type of ['pi:tasks', 'pi:view']) {
      expect(invalidationsFor({ instanceId: 'host', type, sessionId: '17' }, () => false)
        .some((entry) => entry.resource === 'sessions')).toBe(true);
    }
  });
  test('a reply, idle poll, report retrieval or absent receipt cannot imply Done', () => {
    expect(taskIsDone(worker('waiting'))).toBe(false);
    expect(taskStatusSignal(worker('waiting'), 'idle').word).toBe('Waiting');
    expect(taskIsDone(worker('done'))).toBe(false);
    expect(taskIsDone(worker('done', { task: { ...worker('done').task!, completion: { ...completion, task: '17:old' } } }))).toBe(false);
    expect(taskIsDone(worker('done', { task: { ...worker('done').task!, completion } }))).toBe(true);
    expect(taskStatusSignal(worker('done', { task: { ...worker('done').task!, completion } }), 'idle').word).toBe('Completed');
    expect(taskStatusSignal(worker('done'), 'idle').word).not.toBe('Completed');
    expect(taskIsDone({ id: 'old', instanceId: 'host' })).toBe(false);
  });
  test('only a real human blocker says waiting for you', () => {
    expect(taskStatusSignal(worker('waiting'), 'idle').word).not.toContain('you');
    expect(taskStatusSignal(worker('blocked'), 'idle').word).toBe('Blocked');
    expect(taskStatusSignal(worker('blocked', { needsInput: true }), 'idle').word).toBe('Waiting for you');
    expect(taskStatusSignal(worker('stopped'), 'idle').word).toBe('Stopped');
    expect(taskStatusSignal(worker('failed'), 'idle')).toMatchObject({ word: 'Failed', tone: 'failed' });
    expect(taskStatusSignal(worker('working'), 'idle').word).toBe('Working');
  });
  test('counts distinguish active assignments, actual human blockers and completion', () => {
    const tasks = [worker('waiting'), worker('done'), worker('stopped'), worker('blocked', { needsInput: true }), worker('working'), worker('failed')]
      .map((session, index) => ({ ...session, id: String(index) }));
    tasks[1].task = { ...tasks[1].task!, completion };
    const counts = threadShelfStatus(tasks, [], () => 'idle');
    expect(counts).toMatchObject({ total: 6, running: 1, needsHuman: 1, summary: '3 active' });
    expect(counts.detail).toContain('1 completed');
    expect(counts.detail).toContain('1 stopped');
    expect(counts.detail).toContain('1 failed');
  });
  test('unfinished outcomes retain evidence without active/completed counts or false success', () => {
    const tasks = (['blocked', 'incomplete', 'handoff-needed'] as const).map((outcome, i) => worker(outcome, {
      id: String(i), task: { ...worker(outcome).task!, completion: { ...completion, outcome } },
    }));
    for (const task of tasks) {
      expect(taskIsDone(task)).toBe(false);
      expect(taskIsUnfinished(task)).toBe(true);
      expect(taskStatusSignal(task).word).not.toMatch(/Working|Completed|Waiting for you/);
      expect(piConversationToSession('host', { id: task.id, kind: 'worker', task: task.task }).task).toEqual(task.task);
    }
    const counts = threadShelfStatus(tasks, [], () => 'idle');
    expect(counts).toMatchObject({ running: 0, needsHuman: 0, summary: '0 active' });
    expect(counts.detail).toContain('3 unfinished');
    expect(counts.detail).toContain('0 completed');
    expect(taskIsDone(worker('done', { task: { ...worker('done').task!, completion: { ...completion, outcome: 'incomplete' } } }))).toBe(false);
  });
  test('wire preserves stable outcome identity/title and completion independently of chat title', () => {
    const task = { ...worker('done').task!, completion };
    const mapped = piConversationToSession('host', { id: 17, title: 'Renamed source', kind: 'worker', task });
    expect(mapped.task).toEqual(task);
    expect(mapped.title).toBe('Renamed source');
    expect(taskIsDone(mapped)).toBe(true);
    expect(piConversationToSession('old-host', { id: 17, kind: 'worker' }).task).toBeUndefined();
  });
});
