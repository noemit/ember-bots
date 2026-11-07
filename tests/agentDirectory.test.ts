import { describe, expect, test } from 'bun:test';
import {
  AGENT_MESSAGE_HOURLY_BUDGET,
  agentAddress,
  agentMessageBudgetRefusal,
  buildDirectoryGroups,
  canSendAgentMessage,
  directoryCount,
  directoryEmptyCopy,
  hostDirectoryNote,
  resolveAddressableAgent,
  resolveAgentName,
  type DirectoryAgent,
  type DirectoryHost,
} from '../src/lib/agentDirectory';
import type { Session } from '../src/types';

/**
 * The directory view is the first place Ember shows Hearth's named agents at all. These pin the parts
 * that would quietly lie: order (pinned first, as Hearth sorts it), the three ways a host can fail to
 * answer, and the rule a cross-host send will rest on — a bare name is only addressable when unique.
 */
const agent = (name: string, over: Partial<DirectoryAgent> = {}): DirectoryAgent => ({
  name,
  host: 'local',
  conversationId: '42',
  busy: false,
  needsInput: false,
  pinned: false,
  ...over,
});

const host = (label: string, directory: DirectoryHost['directory'], status: DirectoryHost['instanceStatus'] = 'ready'): DirectoryHost => ({
  instanceId: `pi:${label}`,
  label,
  instanceStatus: status,
  directory,
});

describe('grouping the directory by host', () => {
  test('pinned first, then most recent, then by name — Hearth\'s own order', () => {
    const groups = buildDirectoryGroups([
      host('Heliograph', {
        state: 'agents',
        agents: [
          agent('reviewer', { lastActivity: 100 }),
          agent('archivist', { pinned: true, lastActivity: 10 }),
          agent('builder', { lastActivity: 500 }),
          agent('copywriter', { lastActivity: 100 }),
        ],
      }),
    ]);
    expect(groups[0].rows.map((row) => row.agent.name)).toEqual(['archivist', 'builder', 'copywriter', 'reviewer']);
  });

  test('one section per host, in the instance order, with host-qualified addresses', () => {
    const groups = buildDirectoryGroups([
      host('Heliograph', { state: 'agents', agents: [agent('reviewer')] }),
      host('Tower', { state: 'agents', agents: [agent('reviewer')] }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(['Heliograph', 'Tower']);
    expect(groups[0].rows[0].address).toBe('Heliograph/reviewer');
    expect(directoryCount(groups)).toBe(2);
    expect(agentAddress('', 'x')).toBe('unknown/x');
  });

  test('a host that did not answer has no rows, and says so rather than showing none', () => {
    const groups = buildDirectoryGroups([host('Tower', { state: 'silent' }, 'unreachable')]);
    expect(groups[0].rows).toEqual([]);
    expect(hostDirectoryNote(groups[0].directory)).toMatch(/Not answering/);
    // The distinction matters: unknown is not absent.
    expect(hostDirectoryNote(groups[0].directory)).toMatch(/unknown/);
  });

  test('a connection with no directory is not an outage', () => {
    const note = hostDirectoryNote({ state: 'unsupported' });
    expect(note).toMatch(/serves no agent directory/);
    expect(note).not.toMatch(/Not answering/);
  });

  test('an answering host with nothing registered says how a name gets made', () => {
    expect(hostDirectoryNote({ state: 'agents', agents: [] })).toMatch(/Promote a worker/);
    expect(hostDirectoryNote({ state: 'agents', agents: [agent('a')] })).toBeNull();
  });

  test('the empty state names the case instead of asserting absence', () => {
    expect(directoryEmptyCopy([])).toMatch(/No ember-harness endpoints yet/);
    expect(directoryEmptyCopy([host('Tower', { state: 'silent' })] )).toMatch(/No host is serving a directory/);
    expect(directoryEmptyCopy([host('Tower', { state: 'agents', agents: [] })])).toMatch(/Promote a worker/);
  });
});

describe('resolving a bare name across hosts', () => {
  const groups = buildDirectoryGroups([
    host('Heliograph', { state: 'agents', agents: [agent('reviewer'), agent('builder')] }),
    host('Tower', { state: 'agents', agents: [agent('archivist')] }),
  ]);

  test('a name on exactly one host resolves to it', () => {
    const found = resolveAgentName(groups, 'archivist');
    expect(found.kind).toBe('unique');
    if (found.kind !== 'unique') throw new Error('unreachable');
    expect(found.row.address).toBe('Tower/archivist');
  });

  test('the same name on two hosts is ambiguous, and both are offered', () => {
    const both = buildDirectoryGroups([
      host('Heliograph', { state: 'agents', agents: [agent('reviewer')] }),
      host('Tower', { state: 'agents', agents: [agent('reviewer')] }),
    ]);
    const found = resolveAgentName(both, 'reviewer');
    expect(found.kind).toBe('ambiguous');
    if (found.kind !== 'ambiguous') throw new Error('unreachable');
    expect(found.rows.map((row) => row.address)).toEqual(['Heliograph/reviewer', 'Tower/reviewer']);
  });

  test('case and whitespace do not change which agent is meant', () => {
    expect(resolveAgentName(groups, '  Archivist ').kind).toBe('unique');
  });

  test('an unknown name and an empty one are the same answer: nothing to resolve', () => {
    expect(resolveAgentName(groups, 'nobody').kind).toBe('unknown');
    expect(resolveAgentName(groups, '   ').kind).toBe('unknown');
  });
});

describe('resolving session titles with window and all-time follow-up', () => {
  const now = 1_700_000_000_000;
  const hour = 60 * 60 * 1000;
  const groups = buildDirectoryGroups([
    host('Heliograph', { state: 'agents', agents: [agent('reviewer')] }),
    host('Tower', { state: 'agents', agents: [] }),
  ]);

  const session = (id: string, title: string, updated: number, extra: Partial<Session> = {}): Session => ({
    id,
    instanceId: 'pi:Heliograph',
    title,
    updated,
    ...extra,
  });

  test('registry name wins first, then a unique session title within the window', () => {
    const sessions = [
      session('s1', 'Lazy Librarian', now - 2 * hour),
      session('s2', 'Spotted Fox', now - 100 * hour),
    ];
    const reg = resolveAddressableAgent({ groups, sessions, name: 'reviewer', windowHours: 48, now });
    expect(reg.kind).toBe('unique');
    if (reg.kind === 'unique') expect(reg.source).toBe('registry');

    const titleHit = resolveAddressableAgent({ groups, sessions, name: 'Lazy Librarian', windowHours: 48, now });
    expect(titleHit.kind).toBe('unique');
    if (titleHit.kind === 'unique') {
      expect(titleHit.source).toBe('title');
      expect(titleHit.row.agent.conversationId).toBe('s1');
    }
  });

  test('a session outside the window asks whether to search all time, and searchAllTime resolves it', () => {
    const sessions = [session('s2', 'Spotted Fox', now - 100 * hour)];
    const outside = resolveAddressableAgent({ groups, sessions, name: 'Spotted Fox', windowHours: 48, now });
    expect(outside.kind).toBe('outside-window');
    if (outside.kind === 'outside-window') {
      expect(outside.question).toContain('No agent called "Spotted Fox" in the last 2 days.');
      expect(outside.question).toContain('Would you like to search all of your agents — all time');
    }

    const widened = resolveAddressableAgent({
      groups,
      sessions,
      name: 'Spotted Fox',
      windowHours: 48,
      searchAllTime: true,
      now,
    });
    expect(widened.kind).toBe('unique');
    if (widened.kind === 'unique') expect(widened.row.agent.conversationId).toBe('s2');
  });

  test('a silent host says so instead of claiming the agent does not exist', () => {
    const withSilent = buildDirectoryGroups([
      host('Heliograph', { state: 'agents', agents: [] }),
      host('Tower', { state: 'silent' }, 'unreachable'),
    ]);
    const res = resolveAddressableAgent({ groups: withSilent, sessions: [], name: 'Archivist', now });
    expect(res.kind).toBe('silent-hosts');
    if (res.kind === 'silent-hosts') {
      expect(res.message).toContain("Tower didn't answer");
      expect(res.message).not.toMatch(/no agent called/i);
    }
  });

  test('enforces the 60 messages per hour budget per conversation', () => {
    const recent = Array.from({ length: AGENT_MESSAGE_HOURLY_BUDGET - 1 }, (_, i) => now - i * 1000);
    expect(canSendAgentMessage(recent, now)).toBe(true);
    expect(canSendAgentMessage([...recent, now - 500], now)).toBe(false);
    // Timestamps older than an hour age out.
    const aged = Array.from({ length: AGENT_MESSAGE_HOURLY_BUDGET }, () => now - 2 * hour);
    expect(canSendAgentMessage(aged, now)).toBe(true);
    expect(agentMessageBudgetRefusal()).toContain('60 agent messages in the last hour');
  });
});
