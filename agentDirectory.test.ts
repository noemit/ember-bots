import { describe, expect, test } from 'bun:test';
import {
  agentAddress,
  buildDirectoryGroups,
  directoryCount,
  directoryEmptyCopy,
  hostDirectoryNote,
  resolveAgentName,
  type DirectoryAgent,
  type DirectoryHost,
} from './src/lib/agentDirectory';

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
