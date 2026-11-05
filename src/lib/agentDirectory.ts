/**
 * The **agent directory**, across hosts: who is addressable, where, and how they are doing.
 *
 * Hearth has registered named agents per host since its coagent work — one conversation per name, and
 * only a *human* may register one, by promoting a worker (`POST /conversations/:id/promote`, which
 * Ember's `PromoteWorkerDialog` already drives). Agents themselves may list and send, but deliberately
 * cannot register: "agents can widen their own awareness but not the set of addressable agents"
 * (`hearth/src/agents.ts`). `GET /directory` serves that registry merged with live status.
 *
 * Ember showed none of it: a promoted peer appeared in the rail like any other session, and there was
 * nowhere to see which names exist, on which host. This module is the pure half of the view that fixes
 * that — grouping by host, pinned first, with the three ways a host can fail to answer kept apart.
 *
 * It is also the first piece a cross-host `send` would need (see TODO.md): a name is only addressable
 * if it is unique across every connected host, which cannot be decided without this list.
 */
import type { Instance } from '../types';

/** One registered agent, as a host reports it (Hearth's `DirectoryEntry`). */
export type DirectoryAgent = {
  name: string;
  /** The host that owns the name. `"local"` today; federation would put peer labels here. */
  host: string;
  conversationId: string;
  title?: string;
  kind?: 'worker' | 'peer';
  busy: boolean;
  needsInput: boolean;
  pinned: boolean;
  /** When it was last active, for ordering within a host. */
  lastActivity?: number;
};

/** What one host said when Ember asked it for its directory. */
export type HostDirectory =
  /** Ember has not asked yet (or the answer is still in flight). */
  | { state: 'checking' }
  | { state: 'agents'; agents: DirectoryAgent[] }
  /** The host answered but serves no directory (an OpenChamber instance, or an older Hearth). */
  | { state: 'unsupported' }
  /** The host did not answer: its names are *unknown*, not absent. */
  | { state: 'silent' };

export type DirectoryHost = {
  instanceId: string;
  label: string;
  instanceStatus: Instance['status'];
  directory: HostDirectory;
};

export type DirectoryRow = {
  instanceId: string;
  agent: DirectoryAgent;
  /** `host/name`, the only unambiguous way to write it once more than one host has agents. */
  address: string;
};

export type DirectoryGroup = {
  instanceId: string;
  label: string;
  instanceStatus: Instance['status'];
  directory: HostDirectory;
  /** Empty for a host that did not answer or serves no directory. */
  rows: DirectoryRow[];
};

/** The address a person or an agent writes: `host/name`. */
export const agentAddress = (hostLabel: string, name: string): string =>
  `${hostLabel.trim() || 'unknown'}/${name}`;

/**
 * Group the answers into the view's sections, in the order the instance list already uses.
 *
 * Within a host: **pinned first**, then most recent activity, then by name — the same order Hearth's
 * own `mergeDirectory` produces, so Ember is not inventing a second notion of "important".
 */
export const buildDirectoryGroups = (hosts: readonly DirectoryHost[]): DirectoryGroup[] =>
  hosts.map((host) => {
    const agents = host.directory.state === 'agents' ? host.directory.agents : [];
    const rows = [...agents]
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          (b.lastActivity ?? 0) - (a.lastActivity ?? 0) ||
          a.name.localeCompare(b.name)
      )
      .map((agent) => ({
        instanceId: host.instanceId,
        agent,
        address: agentAddress(host.label, agent.name),
      }));
    return {
      instanceId: host.instanceId,
      label: host.label,
      instanceStatus: host.instanceStatus,
      directory: host.directory,
      rows,
    };
  });

/** How many names are addressable across every host that answered. */
export const directoryCount = (groups: readonly DirectoryGroup[]): number =>
  groups.reduce((total, group) => total + group.rows.length, 0);

/**
 * A name's addresses across every host that answered.
 *
 * The cross-host rule this exists for: a bare name is only addressable when it is **unique**. Two
 * hosts with a `Reviewer` is not a choice Ember may make silently, and neither is a host that did not
 * answer — its names are unknown, so uniqueness cannot be established while it is silent.
 */
export const resolveAgentName = (
  groups: readonly DirectoryGroup[],
  name: string
): { kind: 'unique'; row: DirectoryRow } | { kind: 'ambiguous'; rows: DirectoryRow[] } | { kind: 'unknown' } => {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return { kind: 'unknown' };
  const matches = groups.flatMap((group) => group.rows).filter((row) => row.agent.name.toLowerCase() === wanted);
  if (matches.length === 0) return { kind: 'unknown' };
  if (matches.length === 1) return { kind: 'unique', row: matches[0] };
  return { kind: 'ambiguous', rows: matches };
};

/** The per-host line under a section heading: what the reader can conclude. */
export const hostDirectoryNote = (directory: HostDirectory): string | null => {
  if (directory.state === 'checking') return null;
  if (directory.state === 'silent') {
    return 'Not answering, so its agents are unknown right now — not gone. They come back when it does.';
  }
  if (directory.state === 'unsupported') {
    return 'This connection serves no agent directory, so nothing here can be addressed by name.';
  }
  if (directory.agents.length === 0) {
    return 'No named agents yet. Promote a worker to give it a name — only a person can.';
  }
  return null;
};

/** The whole view's empty line, when even the hosts that answered have nothing. */
export const directoryEmptyCopy = (groups: readonly DirectoryGroup[]): string => {
  if (groups.length === 0) {
    return 'No ember-harness endpoints yet. Add one in Settings → Instances and its agents appear here.';
  }
  if (groups.every((group) => group.directory.state !== 'agents')) {
    return 'No host is serving a directory right now. Check Settings → Instances, then come back.';
  }
  return 'No named agents yet. Promote a worker from its column header to give it a name.';
};
