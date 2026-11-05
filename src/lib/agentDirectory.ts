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
import type { Instance, Session } from '../types';
import { isWorker } from './crew';

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
  const allRows = groups.flatMap((group) => group.rows);
  // Support explicit `host/name` qualification as well as bare names.
  const byAddress = allRows.filter((row) => row.address.toLowerCase() === wanted);
  if (byAddress.length === 1) return { kind: 'unique', row: byAddress[0] };
  if (byAddress.length > 1) return { kind: 'ambiguous', rows: byAddress };
  const matches = allRows.filter((row) => row.agent.name.toLowerCase() === wanted);
  if (matches.length === 0) return { kind: 'unknown' };
  if (matches.length === 1) return { kind: 'unique', row: matches[0] };
  return { kind: 'ambiguous', rows: matches };
};

/**
 * Loop control for cross-agent messaging: at most 60 messages per hour per conversation.
 */
export const AGENT_MESSAGE_HOURLY_BUDGET = 60;
export const AGENT_MESSAGE_BUDGET_WINDOW_MS = 60 * 60 * 1000;

export const pruneAgentMessageTimestamps = (
  sentAt: readonly number[],
  now: number,
  windowMs = AGENT_MESSAGE_BUDGET_WINDOW_MS
): number[] => sentAt.filter((at) => now - at < windowMs);

export const canSendAgentMessage = (
  sentAt: readonly number[],
  now: number,
  budget = AGENT_MESSAGE_HOURLY_BUDGET,
  windowMs = AGENT_MESSAGE_BUDGET_WINDOW_MS
): boolean => pruneAgentMessageTimestamps(sentAt, now, windowMs).length < budget;

export const agentMessageBudgetRefusal = (budget = AGENT_MESSAGE_HOURLY_BUDGET): string =>
  `Refused: this conversation has sent ${budget} agent messages in the last hour. Wait before sending more so two agents cannot loop.`;

/**
 * Format the window duration in human terms ("last 2 days", "last 5 hours") for the not-found
 * follow-up question.
 */
export const formatWindowLabel = (windowHours: number): string => {
  if (windowHours <= 0 || !Number.isFinite(windowHours)) return 'all time';
  if (windowHours % 24 === 0) {
    const days = windowHours / 24;
    return `last ${days} ${days === 1 ? 'day' : 'days'}`;
  }
  return `last ${windowHours} ${windowHours === 1 ? 'hour' : 'hours'}`;
};

export type AddressableResolution =
  | { kind: 'unique'; row: DirectoryRow; source: 'registry' | 'title' }
  | { kind: 'ambiguous'; rows: DirectoryRow[]; message: string }
  | { kind: 'outside-window'; rows: DirectoryRow[]; question: string }
  | { kind: 'silent-hosts'; silentLabels: string[]; message: string }
  | { kind: 'unknown'; message: string };

/**
 * Resolve an agent by registry name first, then by session title (including auto-derived titles)
 * within the active rail window (`windowHours`, default 48h = 2 days).
 *
 * Rules:
 * - Registry name wins first (exact or `host/name`).
 * - Otherwise, non-worker sessions with a matching title inside `windowHours` are considered.
 * - If nothing matches inside the window, but a session title matches in all-time history
 *   (`searchAllTime: false`), returns `outside-window` with the question offering to widen the
 *   search to all time. When `searchAllTime: true`, those older sessions resolve directly.
 * - If nothing matches and one or more hosts are `silent`, names the silent host(s) ("Tower didn't
 *   answer") rather than claiming no such agent exists.
 */
export const resolveAddressableAgent = (input: {
  groups: readonly DirectoryGroup[];
  sessions?: readonly Session[];
  name: string;
  windowHours?: number;
  searchAllTime?: boolean;
  now?: number;
}): AddressableResolution => {
  const {
    groups,
    sessions = [],
    name,
    windowHours = 48,
    searchAllTime = false,
    now = Date.now(),
  } = input;
  const trimmed = name.trim();
  const wanted = trimmed.toLowerCase();
  if (!wanted) {
    return { kind: 'unknown', message: 'Provide an agent name to message.' };
  }

  // 1. Registry name first (exact bare name or `host/name`).
  const registryHit = resolveAgentName(groups, trimmed);
  if (registryHit.kind === 'unique') {
    return { kind: 'unique', row: registryHit.row, source: 'registry' };
  }
  if (registryHit.kind === 'ambiguous') {
    const addresses = registryHit.rows.map((r) => r.address).join(', ');
    return {
      kind: 'ambiguous',
      rows: registryHit.rows,
      message: `More than one agent is named "${trimmed}": ${addresses}. Specify the host as host/name.`,
    };
  }

  // 2. Session titles (including auto-derived titles), excluding another leader's workers.
  const hostLabels = new Map(groups.map((g) => [g.instanceId, g.label]));
  const cutoff =
    !searchAllTime && windowHours > 0 && Number.isFinite(windowHours)
      ? now - windowHours * 60 * 60 * 1000
      : 0;

  const toRow = (session: Session): DirectoryRow => {
    const hostLabel = hostLabels.get(session.instanceId) ?? session.instanceId;
    const title = session.title?.trim() || session.id;
    return {
      instanceId: session.instanceId,
      address: agentAddress(hostLabel, title),
      agent: {
        name: title,
        host: hostLabel,
        conversationId: session.id,
        title,
        kind: session.kind,
        busy: false,
        needsInput: session.needsInput === true,
        pinned: false,
        lastActivity: session.updated,
      },
    };
  };

  const titleMatches = sessions.filter((session) => {
    if (session.archived || isWorker(session)) return false;
    const title = session.title?.trim();
    if (!title) return false;
    const hostLabel = hostLabels.get(session.instanceId) ?? session.instanceId;
    return (
      title.toLowerCase() === wanted ||
      agentAddress(hostLabel, title).toLowerCase() === wanted
    );
  });

  const inWindow = cutoff > 0
    ? titleMatches.filter((session) => (session.updated ?? 0) >= cutoff)
    : titleMatches;

  if (inWindow.length === 1) {
    return { kind: 'unique', row: toRow(inWindow[0]), source: 'title' };
  }
  if (inWindow.length > 1) {
    const rows = inWindow.map(toRow);
    const addresses = rows.map((r) => `${r.address} (${r.agent.conversationId})`).join(', ');
    return {
      kind: 'ambiguous',
      rows,
      message: `More than one active session is titled "${trimmed}": ${addresses}.`,
    };
  }

  // Found outside the window when `searchAllTime` is false: ask the follow-up question.
  if (!searchAllTime && titleMatches.length > 0) {
    const rows = titleMatches.map(toRow);
    const windowText = formatWindowLabel(windowHours);
    return {
      kind: 'outside-window',
      rows,
      question: `No agent called "${trimmed}" in the ${windowText}. Would you like to search all of your agents — all time, including ones that have been inactive for longer?`,
    };
  }

  // If any host is silent, name the silent host(s) rather than claiming the agent doesn't exist.
  const silentLabels = groups
    .filter((group) => group.directory.state === 'silent')
    .map((group) => group.label);
  if (silentLabels.length > 0) {
    const who = silentLabels.join(', ');
    return {
      kind: 'silent-hosts',
      silentLabels,
      message: `${who} didn't answer, so its agents are unknown right now — not absent. Try again once ${silentLabels.length === 1 ? 'it is' : 'they are'} back.`,
    };
  }

  const windowText = formatWindowLabel(windowHours);
  return {
    kind: 'unknown',
    message:
      !searchAllTime && windowHours > 0
        ? `No agent called "${trimmed}" in the ${windowText}. Would you like to search all of your agents — all time, including ones that have been inactive for longer?`
        : `No agent called "${trimmed}".`,
  };
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
