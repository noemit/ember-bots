import { describe, expect, test } from 'bun:test';
import { processesToStopOnHide } from '../src/lib/hideProcesses';
import { hideElsewhereNote, hideForceStopAsk, hideStopFailure, refusedPids } from '../src/lib/hideStopCopy';
import type { Session } from '../src/types';

const LEAD = 'pi:hearth';

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  instanceId: LEAD,
  ...overrides,
});

const worker = (id: string, lead: string, overrides: Partial<Session> = {}): Session =>
  session(id, { kind: 'worker', lead: { instanceId: LEAD, sessionId: lead }, ...overrides });

const processes = (...pids: number[]) => ({
  count: pids.length,
  rssBytes: pids.length * 1024,
  items: pids.map((pid) => ({ pid, command: `program ${pid}`, rssBytes: 1024, startedAt: 1_700_000_000_000 })),
});

describe('processesToStopOnHide', () => {
  test('a bot with no listed programs asks for nothing', () => {
    expect(processesToStopOnHide(session('a'), [session('a')])).toEqual({ targets: [], elsewhere: 0 });
  });

  test('the bot itself first, then its direct worker', () => {
    const lead = session('lead', { processes: processes(10) });
    const child = worker('w1', 'lead', { processes: processes(11) });
    const { targets } = processesToStopOnHide(lead, [lead, child]);
    expect(targets.map((entry) => entry.session.id)).toEqual(['lead', 'w1']);
    expect(targets.map((entry) => entry.pids)).toEqual([[10], [11]]);
  });

  test('depth two and beyond: a worker’s worker is reached, and sub-workers dedupe by session key', () => {
    const lead = session('lead', { processes: processes(1) });
    const mid = worker('mid', 'lead', { processes: processes(2) });
    const deep = worker('deep', 'mid', { processes: processes(3) });
    const deeper = worker('deeper', 'deep', { processes: processes(4) });
    const { targets } = processesToStopOnHide(lead, [lead, mid, deep, deeper]);
    expect(targets.map((entry) => entry.session.id)).toEqual(['lead', 'mid', 'deep', 'deeper']);
    expect(targets.flatMap((entry) => entry.pids)).toEqual([1, 2, 3, 4]);
  });

  test('a cycle in the lead graph terminates instead of stopping the same session twice', () => {
    const lead = session('lead', { processes: processes(1) });
    const a = worker('a', 'lead', { processes: processes(2) });
    const b = worker('b', 'a', { processes: processes(3) });
    // Malformed data: two survivors of each other, one of them still reachable from the leader.
    const loopedA = { ...a, lead: { instanceId: LEAD, sessionId: 'b' } };
    const loopedB = { ...b, lead: { instanceId: LEAD, sessionId: 'a' } };
    const reached = worker('c', 'lead', { processes: processes(4) });
    const { targets } = processesToStopOnHide(lead, [lead, loopedA, loopedB, reached]);
    const ids = targets.map((entry) => entry.session.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toContain('lead');
    expect(ids).toContain('c');
  });

  test('a surviving cycle can never make the walk loop forever', () => {
    const lead = session('lead', { processes: processes(1) });
    const a = worker('a', 'b', { processes: processes(2) });
    const b = worker('b', 'a', { processes: processes(3) });
    // Neither is reachable from the leader: no descendants, and no hang.
    expect(processesToStopOnHide(lead, [lead, a, b]).targets.map((entry) => entry.session.id)).toEqual(['lead']);
  });

  test('a worker on another host is counted and never sent a stop', () => {
    const lead = session('lead', { processes: processes(1) });
    const other = session('remote', { instanceId: 'pi:other', kind: 'worker', lead: { instanceId: LEAD, sessionId: 'lead' }, processes: processes(9) });
    const mine = worker('mine', 'lead', { processes: processes(2) });
    const result = processesToStopOnHide(lead, [lead, other, mine]);
    expect(result.targets.map((entry) => entry.session.id)).toEqual(['lead', 'mine']);
    expect(result.targets.some((entry) => entry.session.instanceId !== LEAD)).toBe(false);
    expect(result.elsewhere).toBe(1);
  });

  test('a whole branch living elsewhere is counted once per worker', () => {
    const lead = session('lead', { processes: processes(1) });
    const remoteA = session('ra', { instanceId: 'pi:other', kind: 'worker', lead: { instanceId: LEAD, sessionId: 'lead' } });
    const remoteB = session('rb', { instanceId: 'pi:other', kind: 'worker', lead: { instanceId: 'pi:other', sessionId: 'ra' } });
    const result = processesToStopOnHide(lead, [lead, remoteA, remoteB]);
    expect(result.targets.map((entry) => entry.session.id)).toEqual(['lead']);
    expect(result.elsewhere).toBe(2);
  });

  test('an already hidden worker is not stopped again, but its own worker still is', () => {
    const lead = session('lead', { processes: processes(1) });
    const hidden = worker('hidden', 'lead', { archived: 1, processes: processes(2) });
    const under = worker('under', 'hidden', { processes: processes(3) });
    const { targets } = processesToStopOnHide(lead, [lead, hidden, under]);
    expect(targets.map((entry) => entry.session.id)).toEqual(['lead', 'under']);
  });

  test('unrelated sessions are never touched', () => {
    const lead = session('lead', { processes: processes(1) });
    const stranger = session('stranger', { processes: processes(8) });
    const otherLead = session('other-lead', { processes: processes(7) });
    const strangerWorker = worker('sw', 'other-lead', { processes: processes(6) });
    const { targets } = processesToStopOnHide(lead, [lead, stranger, otherLead, strangerWorker]);
    expect(targets.map((entry) => entry.session.id)).toEqual(['lead']);
  });

  test('duplicate pids inside one summary are named once', () => {
    const lead = session('lead', { processes: processes(5, 5, 6) });
    const { targets } = processesToStopOnHide(lead, [lead]);
    expect(targets[0].pids).toEqual([5, 6]);
  });
});

describe('hide stop copy', () => {
  test('a transport failure names the host, says the bot is hidden, and points at Retry', () => {
    const text = hideStopFailure('Studio Mac');
    expect(text).toContain('Studio Mac');
    expect(text).toContain('may still be there');
    expect(text).toContain('hidden');
    expect(text).toContain('Retry');
    expect(text).not.toContain('undefined');
  });

  test('an unnamed host still reads as a sentence', () => {
    expect(hideStopFailure(undefined)).toContain('The host did not answer');
  });

  test('a refused stop asks before forcing and says what force costs', () => {
    const one = hideForceStopAsk([7], 'Studio Mac');
    expect(one).toContain("one program");
    expect(one).toContain('did not stop');
    expect(one).toContain('Force stop');
    expect(one).toContain('unsaved');
    expect(hideForceStopAsk([7, 8], "Studio Mac")).toContain("2 programs");
  });

  test('a crew spread across hosts says the other host was left alone', () => {
    expect(hideElsewhereNote(1)).toContain('One worker');
    expect(hideElsewhereNote(1)).toContain('left alone');
    expect(hideElsewhereNote(2)).toContain('2 workers');
  });

  test('only refused programs are force-stopped; stopped and gone ones are not', () => {
    expect(
      refusedPids([
        { pid: 1, outcome: 'stopped' },
        { pid: 2, outcome: 'refused' },
        { pid: 3, outcome: 'gone' },
        { pid: 4, outcome: 'refused' },
      ])
    ).toEqual([2, 4]);
    expect(refusedPids(undefined)).toEqual([]);
  });
});
