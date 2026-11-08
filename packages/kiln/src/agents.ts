import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  defineDoc,
  defineTool,
  LiveDoc,
  section,
  type ConversationId,
  type Cursor,
  type Extension,
  type PromptInput,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type Tx,
} from "@earendil-works/pi-durable";
import { ApprovalsDoc } from "./approvals";
import { QuestionsDoc } from "./ask";
import { MetaDoc } from "./meta";
import {
  submitCrewMessage,
  findCrewTarget,
  SessionsDoc,
  type CrewEntry,
} from "./sessions";

const CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/**
 * The workspace's AGENTS.md for the conversation's cwd (falling back to `<home>/AGENTS.md` when the
 * project folder has none), rendered into the system prompt per request. Read at render time so an
 * edit shows up on the next request; absent file renders nothing.
 */
export const createAgentsMdSection = (home?: string) =>
  section(
    "agents_md",
    (input: PromptInput) => {
      const cwd = input.agent.cwd;
      const dirs = [
        ...(cwd ? [cwd] : []),
        ...(home && home !== cwd ? [home] : []),
      ];
      for (const dir of dirs) {
        for (const name of CANDIDATES) {
          try {
            const content = readFileSync(join(dir, name), "utf8").trim();
            if (content) return content;
          } catch {
            // try the next candidate
          }
        }
      }
      return undefined;
    },
    { tag: false }
  );

export const agentsMdSection = createAgentsMdSection();

/**
 * The local agent registry (Phase 2 of `COAGENTS_PLAN.md`).
 *
 * Names are only meaningful locally: one conversation per name per host. A **human** promotes
 * a worker into a named peer (`POST /conversations/:id/promote`); agents can list the directory
 * and send to a name, but deliberately cannot register one. That asymmetry is the whole policy:
 * agents can widen their own awareness but not the set of addressable agents.
 *
 * `host` is `"local"` in Phase 2. Phase 3 federates reads and lets a bare name become ambiguous
 * across hosts; the registry shape is already the per-host piece that federation merges.
 *
 * **Registration is automatic.** Every conversation the `session` tool creates — a worker or a
 * spawned peer — is registered under its title in the same commit (`registerAgentWithSuffix`), so a
 * name exists for anything an agent can be told to message about by title. One title can repeat
 * across crews, so a taken name takes a suffix rather than refusing the spawn. What remains
 * human-only is *promotion* (`POST /conversations/:id/promote`), which forks a worker into an
 * ownerless peer: that changes who a conversation belongs to, which is not something an agent should
 * do to itself.
 */
export type AgentEntry = {
  conversationId: number;
  host: string;
  description?: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};

export type PeerEndpoint = {
  id: string;
  label: string;
  url: string;
  token: string;
};

export type AgentsState = {
  entries: Record<string, AgentEntry>;
  /** Peer hosts pushed by Ember so `agents directory` and `agents send` federate across hosts. */
  peers?: PeerEndpoint[];
};

/** 60 messages per hour per conversation: prevents two agents from ping-ponging in a loop. */
export const AGENT_MESSAGE_BUDGET = 60;
export const AGENT_MESSAGE_WINDOW_MS = 60 * 60 * 1000;

export const pruneAgentMessages = (
  sentAt: readonly number[] | undefined,
  now: number,
  windowMs = AGENT_MESSAGE_WINDOW_MS
): number[] => (sentAt ?? []).filter((at) => now - at < windowMs);

export const agentMessageRateLimited = (
  sentAt: readonly number[] | undefined,
  now: number,
  limit = AGENT_MESSAGE_BUDGET,
  windowMs = AGENT_MESSAGE_WINDOW_MS
): boolean => pruneAgentMessages(sentAt, now, windowMs).length >= limit;

/** The host-wide (session-scoped) registry: one name per local conversation. */
export const AgentsDoc = defineDoc<AgentsState>({
  kind: "hearth.agents",
  version: 1,
  scope: "session",
  initial: () => ({ entries: {} }),
  checkpointWhen: () => true,
});

/** A duplicate local name. The server maps this to 400; the tool never registers. */
export class DuplicateAgentError extends Error {
  constructor(readonly name: string) {
    super(`bot name already registered: ${name}`);
    this.name = "DuplicateAgentError";
  }
}

export type NamedAgentEntry = AgentEntry & { name: string };

/**
 * Register a local name. Throws `DuplicateAgentError` instead of overwriting: one name per host
 * is the local rule, and an overwrite would silently redirect a send to another conversation.
 */
export const registerAgent = async (tx: Tx, name: string, entry: AgentEntry): Promise<AgentEntry> => {
  const doc = await tx.doc(AgentsDoc);
  if (Object.hasOwn(doc.entries, name)) throw new DuplicateAgentError(name);
  doc.entries[name] = entry;
  return entry;
};

/**
 * Register a conversation under a free name, or under the next free variant of it.
 *
 * The automatic path: a spawned worker is registered the moment it exists, so the directory lists
 * what is actually running instead of only what a person has promoted. Titles repeat (two crews can
 * both spawn "Migrate schema"), so a taken name is suffixed rather than refused — `Name`, `Name 2`,
 * `Name 3` — and the returned name is the one that was registered. A name already pointing at this
 * same conversation is reused instead of duplicating the entry, which keeps a retry idempotent.
 */
export const registerAgentWithSuffix = async (
  tx: Tx,
  preferred: string,
  entry: AgentEntry
): Promise<string> => {
  const doc = await tx.doc(AgentsDoc);
  for (const [name, existing] of Object.entries(doc.entries)) {
    if (existing.conversationId === entry.conversationId) return name;
  }
  const base = oneLine(preferred, 120) || `Agent ${entry.conversationId}`;
  let name = base;
  for (let attempt = 2; Object.hasOwn(doc.entries, name); attempt += 1) {
    name = `${base} ${attempt}`;
    if (attempt > 200) throw new DuplicateAgentError(base);
  }
  doc.entries[name] = entry;
  return name;
};

/** Pin/unpin only changes visibility, not recency: an unpinned old agent falls back by age. */
const setPinned = async (tx: Tx, name: string, pinned: boolean): Promise<AgentEntry | undefined> => {
  const doc = await tx.doc(AgentsDoc);
  const entry = Object.hasOwn(doc.entries, name) ? doc.entries[name] : undefined;
  if (!entry) return undefined;
  entry.pinned = pinned;
  return entry;
};

export const pinAgent = (tx: Tx, name: string): Promise<AgentEntry | undefined> => setPinned(tx, name, true);
export const unpinAgent = (tx: Tx, name: string): Promise<AgentEntry | undefined> => setPinned(tx, name, false);

/** Registry entries, pinned first then most-recently updated. Pure over a snapshot. */
export const listAgents = (
  snapshot: Readonly<AgentsState> | undefined | null
): NamedAgentEntry[] =>
  Object.entries(snapshot?.entries ?? {})
    .map(([name, entry]) => ({ name, ...entry }))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt - a.updatedAt ||
        a.name.localeCompare(b.name)
    );

// ---- directory ---------------------------------------------------------------------------

/** The subset of a conversation summary the directory merges into each registry entry. */
export type DirectorySummary = {
  title?: string;
  archived?: number;
  kind?: "worker" | "peer";
  lead?: { conversationId: number; host: string };
  busy?: boolean;
  needsInput?: boolean;
  updatedAt?: number;
  lastActivity?: number;
};

export type DirectoryEntry = NamedAgentEntry & {
  title?: string;
  kind?: "worker" | "peer";
  lead?: { conversationId: number; host: string };
  busy: boolean;
  needsInput: boolean;
  lastActivity?: number;
};

/**
 *Registry names whose conversation is gone or archived and should be pruned lazily. Pure.
 */
export const staleAgentNames = (
  entries: readonly NamedAgentEntry[],
  summaries: ReadonlyMap<number, DirectorySummary>
): string[] => {
  const stale: string[] = [];
  for (const entry of entries) {
    const summary = summaries.get(entry.conversationId);
    if (!summary || summary.archived !== undefined) {
      stale.push(entry.name);
    }
  }
  return stale;
};

/**
 * Remove stale names from `AgentsDoc` inside one serialized commit, and return how many were removed.
 * Checks `staleNames` against the live doc so two concurrent readers cannot race.
 */
export const pruneStaleAgents = async (
  tx: Tx,
  staleNames: readonly string[]
): Promise<number> => {
  if (staleNames.length === 0) return 0;
  const doc = await tx.doc(AgentsDoc);
  let removed = 0;
  for (const name of staleNames) {
    if (Object.hasOwn(doc.entries, name)) {
      delete doc.entries[name];
      removed += 1;
    }
  }
  return removed;
};

/**
 * Merge the registry with conversation summaries. An entry whose conversation is gone or archived
 * is dropped here (and lazily pruned from `AgentsDoc` + `agents.json` by the caller).
 * Pinned first, then newest activity; bounded so the directory can never bloat a prompt.
 */
export const mergeDirectory = (
  entries: readonly NamedAgentEntry[],
  summaries: ReadonlyMap<number, DirectorySummary>,
  limit = 100
): DirectoryEntry[] => {
  const merged: DirectoryEntry[] = [];
  for (const entry of entries) {
    const summary = summaries.get(entry.conversationId);
    if (!summary || summary.archived !== undefined) continue;
    merged.push({
      ...entry,
      ...(summary.title ? { title: summary.title } : {}),
      ...(summary.kind ? { title: summary.title, kind: summary.kind } : {}),
      ...(summary.lead ? { lead: summary.lead } : {}),
      busy: summary.busy ?? false,
      needsInput: summary.needsInput ?? false,
      lastActivity: summary.lastActivity ?? summary.updatedAt,
    });
  }
  merged.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (b.lastActivity ?? b.updatedAt) - (a.lastActivity ?? a.updatedAt) ||
      a.name.localeCompare(b.name)
  );
  return merged.slice(0, limit);
};

/** One bounded line per directory entry, for the tool and prompt. Pure. */
export const formatDirectory = (agents: readonly DirectoryEntry[]): string => {
  if (agents.length === 0) {
    return "No agents are registered yet. Only a human can promote a worker into a named peer.";
  }
  return agents
    .map((agent) => {
      const flags = [agent.host, ...(agent.pinned ? ["pinned"] : [])].join(", ");
      const title = agent.title ? ` — ${agent.title}` : "";
      const status = [
        ...(agent.busy ? ["busy"] : []),
        ...(agent.needsInput ? ["needs input"] : []),
        ...(!agent.busy && !agent.needsInput ? ["idle"] : []),
      ].join(", ");
      return `- ${agent.name} (${flags})${title} [${status}]`;
    })
    .join("\n");
};

// ---- mirror file for the passive prompt section ------------------------------------------

const MIRROR_FILE = "agents.json";
const PEERS_FILE = "peers.json";
export const MAX_MIRROR_AGENTS = 200;

export const agentsMirrorPath = (home: string): string => join(home, MIRROR_FILE);
export const peersMirrorPath = (home: string): string => join(home, PEERS_FILE);

export const writePeersMirror = (home: string, peers: readonly PeerEndpoint[] | undefined): void => {
  try {
    mkdirSync(home, { recursive: true });
    const path = peersMirrorPath(home);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ peers: peers ?? [] }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    console.error("[hearth] writing peers mirror failed:", error instanceof Error ? error.message : error);
  }
};

export const readPeersMirror = (home: string): PeerEndpoint[] => {
  try {
    const parsed = JSON.parse(readFileSync(peersMirrorPath(home), "utf8")) as { peers?: unknown };
    if (!Array.isArray(parsed?.peers)) return [];
    return parsed.peers.filter(
      (item): item is PeerEndpoint =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as PeerEndpoint).label === "string" &&
        typeof (item as PeerEndpoint).url === "string" &&
        typeof (item as PeerEndpoint).token === "string"
    );
  } catch {
    return [];
  }
};

/**
 * Mirror the registry to `<home>/agents.json`. The durable doc stays the source of truth; the
 * file exists because prompt sections render from a file read at request time and have no
 * document access. Failure to write is logged, never thrown: a stale hint must not fail a
 * register/pin.
 */
export const writeAgentsMirror = (home: string, snapshot: Readonly<AgentsState> | undefined | null): void => {
  try {
    mkdirSync(home, { recursive: true });
    const path = agentsMirrorPath(home);
    const temporary = `${path}.tmp`;
    // Bound the mirror by recency (pinned first, then newest updatedAt) so `<home>/agents.json`
    // stays a readable, bounded file even if many conversations were spawned.
    const sorted = listAgents(snapshot).slice(0, MAX_MIRROR_AGENTS);
    const boundedEntries: Record<string, AgentEntry> = {};
    for (const { name, ...entry } of sorted) {
      boundedEntries[name] = entry;
    }
    const mirror = { entries: boundedEntries };
    writeFileSync(temporary, `${JSON.stringify(mirror, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    console.error("[hearth] writing agents mirror failed:", error instanceof Error ? error.message : error);
  }
};

/** Read the mirror. Absent, empty or malformed renders nothing rather than failing a request. */
export const readAgentsMirror = (home: string): Record<string, AgentEntry> | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(agentsMirrorPath(home), "utf8")) as { entries?: unknown };
    const entries = parsed?.entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return undefined;
    const valid: Record<string, AgentEntry> = {};
    for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Partial<AgentEntry>;
      if (typeof entry.conversationId !== "number" || typeof entry.host !== "string") continue;
      valid[name] = {
        conversationId: entry.conversationId,
        host: entry.host,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        pinned: entry.pinned === true,
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
      };
    }
    return valid;
  } catch {
    return undefined;
  }
};

/** Keep a description on one line and bounded, so a registry edit can't bloat the prompt. */
const oneLine = (text: string, limit = 140): string => text.replace(/\s+/g, " ").trim().slice(0, limit);

/**
 * The `known_agents` prompt section body: every pinned agent plus the three most recently
 * updated, one bounded line each. Pure and unit-testable; the section reads the mirror file.
 */
export const renderKnownAgents = (entries: Record<string, AgentEntry> | undefined): string | undefined => {
  if (!entries) return undefined;
  const all = listAgents({ entries });
  if (all.length === 0) return undefined;
  const pinned = all.filter((entry) => entry.pinned);
  const recent = [...all]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    .filter((entry) => !entry.pinned)
    .slice(0, 3);
  const chosen = [...pinned, ...recent];
  if (chosen.length === 0) return undefined;
  const lines = chosen.map((entry) => {
    const flags = [entry.host, ...(entry.pinned ? ["pinned"] : [])].join(", ");
    const description = entry.description ? ` — ${oneLine(entry.description)}` : "";
    return `- ${entry.name} (${flags})${description}`;
  });
  return `Known agents you can message by name with the \`agents\` tool:\n${lines.join("\n")}`;
};

export const knownAgentsSection = (home: string) =>
  section("known_agents", () => renderKnownAgents(readAgentsMirror(home)), { tag: false });

// ---- the `agents` tool -------------------------------------------------------------------

/** Stable outbox-style request id: replaying the same tool task reacquires the same submission. */
export const agentMessageRequestId = (
  sender: ConversationId,
  name: string,
  taskId: unknown
): string => `hearth.agents.msg:${sender}:${name}:${String(taskId)}`;

/** One conversation's directory view, using the same signals as `summaryOf` in `server.ts`. */
const summaryFor = async (
  api: ToolExecutionApi,
  id: ConversationId,
  context: Context
): Promise<DirectorySummary | undefined> => {
  // A tool has no entry access, so it can only tell that the conversation still exists; the
  // registry's own `updatedAt` backs the recency shown in `directory`.
  if (!(await api.conversation(id, context))) return undefined;
  const [meta, live, approvals, questions] = await Promise.all([
    api.snapshot(MetaDoc, id, context),
    api.snapshot(LiveDoc, id, context),
    api.snapshot(ApprovalsDoc, id, context),
    api.snapshot(QuestionsDoc, id, context),
  ]);
  const pendingApproval = Object.values(approvals?.items ?? {}).some((item) => item.status === "pending");
  const pendingQuestion = Object.values(questions?.items ?? {}).some((item) => item.status === "pending");
  return {
    ...(meta?.title ? { title: meta.title } : {}),
    ...(meta?.archived !== undefined ? { archived: meta.archived } : {}),
    ...(meta?.kind ? { kind: meta.kind } : {}),
    ...(meta?.lead ? { lead: meta.lead } : {}),
    busy: Boolean(live?.run),
    needsInput: pendingApproval || pendingQuestion,
  };
};

/** How many conversations the "not my crew" scan walks before it gives up. */
const FOREIGN_CREW_SCAN_LIMIT = 2_000;

/**
 * A crew entry that answers to `name` in some *other* conversation's crew doc. A tool cannot list
 * conversations directly, so this scans the durable conversation records and reads each leader's
 * crew doc. Only the refusal path calls it, and only when the name resolved nowhere else.
 */
const foreignCrewEntry = async (
  api: ToolExecutionApi,
  name: string,
  context: Context
): Promise<{ lead: ConversationId; key: string; entry: CrewEntry } | undefined> => {
  const candidates = await api.commit(async (tx) => {
    const ids: ConversationId[] = [];
    let cursor: Cursor | undefined;
    while (ids.length < FOREIGN_CREW_SCAN_LIMIT) {
      const page = await tx.scanConversations({}, 200, cursor);
      for (const record of page.items) {
        if (record.id === api.conversationId) continue;
        ids.push(record.id);
      }
      if (!page.next) break;
      cursor = page.next;
    }
    return ids;
  }, context);
  for (const id of candidates) {
    const crew = await api.snapshot(SessionsDoc, id, context);
    if (!crew) continue;
    const match = findCrewTarget(crew.items, name);
    if (match) return { lead: id, key: match.key, entry: match.entry };
  }
  return undefined;
};

/**
 * A non-worker conversation on this host whose `meta.title` matches `name` (case-insensitive).
 * Used when `name` is an auto-derived session title rather than an explicit registry key.
 */
const titleMatchedConversations = async (
  api: ToolExecutionApi,
  name: string,
  context: Context
): Promise<Array<{ id: ConversationId; title: string }>> => {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return [];
  const candidates = await api.commit(async (tx) => {
    const ids: ConversationId[] = [];
    let cursor: Cursor | undefined;
    while (ids.length < FOREIGN_CREW_SCAN_LIMIT) {
      const page = await tx.scanConversations({}, 200, cursor);
      for (const record of page.items) {
        if (record.id === api.conversationId) continue;
        ids.push(record.id);
      }
      if (!page.next) break;
      cursor = page.next;
    }
    return ids;
  }, context);
  const matches: Array<{ id: ConversationId; title: string }> = [];
  for (const id of candidates) {
    const meta = await api.snapshot(MetaDoc, id, context);
    if (!meta || meta.archived || meta.kind === "worker") continue;
    const title = meta.title?.trim();
    if (title && title.toLowerCase() === wanted) {
      matches.push({ id, title });
    }
  }
  return matches;
};

/**
 * Query configured peer hosts (`state.peers` or `<home>/peers.json`) for their `/directory`.
 */
const queryPeerDirectories = async (
  peers: readonly PeerEndpoint[]
): Promise<{
  entries: DirectoryEntry[];
  silentPeers: string[];
}> => {
  const entries: DirectoryEntry[] = [];
  const silentPeers: string[] = [];
  await Promise.all(
    peers.map(async (peer) => {
      try {
        const response = await fetch(`${peer.url.replace(/\/+$/, "")}/directory`, {
          headers: { authorization: `Bearer ${peer.token}` },
          signal: AbortSignal.timeout(4_000),
        });
        if (!response.ok) {
          silentPeers.push(peer.label);
          return;
        }
        const body = (await response.json().catch(() => null)) as { agents?: DirectoryEntry[] } | null;
        for (const agent of Array.isArray(body?.agents) ? body.agents : []) {
          entries.push({ ...agent, host: peer.label });
        }
      } catch {
        silentPeers.push(peer.label);
      }
    })
  );
  return { entries, silentPeers };
};

/** Format a message arriving from another host so the recipient knows it is foreign. */
export const formatForeignAgentMessage = (senderHost: string, senderName: string, message: string): string =>
  `[Message from agent ${senderHost}/${senderName}]:\n${message}`;

/**
 * `agents` — the directory and direct messaging for named peers:
 * - `directory`: registered agents merged with live conversation status.
 * - `send` (name, message, followUp?): submit to that conversation, idempotently per tool task.
 * - `pin` / `unpin` (name): widen or narrow the directory (agents may do this; they may not
 *   register).
 *
 * There is deliberately **no `register` action**: only a human promotes a worker into a peer.
 *
 * `send` resolves the caller's **own crew first** (a worker by the crew name it spawned, or by
 * its title such as `Researcher #1`), then the registered directory, then a unique local session
 * title, and finally configured peer hosts (`state.peers` / `peers.json`). A worker of another
 * leader is refused: a conversation only drives the crew it started.
 */
export const createAgentsTool = (home: string) =>
  defineTool({
    name: "agents",
    description:
      "Work with the named agents in your directory, and with the crew you lead. `directory` lists " +
      "registered agents with their host, title and busy/needs-input status; `send` (name, message, " +
      "followUp?) hands a message to the agent or crew member with that name; `pin`/`unpin` (name) " +
      "keep an agent in the directory or let it age out. `send` reaches your own crew workers by " +
      "their crew name or their title (`Researcher #1`) before it looks at the directory, so you can " +
      "give one of them another task instead of spawning a new worker. Queuing is what you want for " +
      "a busy worker: pass `followUp: true` and the message lands when the worker's current turn " +
      "ends, instead of interrupting it. A worker of another leader cannot be messaged: only the " +
      "conversation that leads a crew can send to it. There is deliberately no register action: " +
      "only a human can promote a worker into a named agent.",
    parameters: obj({
      action: oneOf(["directory", "send", "pin", "unpin"], {
        description: "directory: list; send: message an agent; pin/unpin: keep it in the directory.",
      }),
      name: opt(
        str({
          description:
            "send: the agent's registered name, or a crew member of yours by crew name or title " +
            "(`Researcher #1`). pin/unpin: the agent's registered name.",
        })
      ),
      message: opt(str({ description: "send: the message to hand to the agent." })),
      followUp: opt(
        bool({
          description:
            "send: true queues it after the agent's current answer instead of steering into it. " +
            "Use true for a busy worker: the message then lands when its current turn ends.",
        })
      ),
    }),
    // The send requestId is derived from the durable tool task id, so a crash rerun reacquires
    // the same submission and none of the other actions mutate anything but the registry.
    replay: "safe",
    execute: async (args, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
      const { action, name, message, followUp } = args;
      const reply = (text: string, conversationId?: number): ToolExecutionResult => ({
        output: [{ type: "text" as const, text }],
        ...(conversationId === undefined || name === undefined
          ? {}
          : { details: { name, conversationId: String(conversationId) } }),
      });

      const state = await api.snapshot(AgentsDoc, context);
      const peers = state?.peers ?? readPeersMirror(home);

      if (action === "directory") {
        const entries = listAgents(state);
        const summaries = new Map<number, DirectorySummary>();
        for (const entry of entries) {
          const summary = await summaryFor(api, entry.conversationId as ConversationId, context);
          if (summary) summaries.set(entry.conversationId, summary);
        }
        const stale = staleAgentNames(entries, summaries);
        if (stale.length > 0) {
          const removed = await api.commit((tx) => pruneStaleAgents(tx, stale), context);
          if (removed > 0) {
            writeAgentsMirror(home, await api.snapshot(AgentsDoc, context));
          }
        }
        const localMerged = mergeDirectory(entries, summaries);
        if (peers.length === 0) {
          return reply(formatDirectory(localMerged));
        }
        const remote = await queryPeerDirectories(peers);
        const combined = [...localMerged, ...remote.entries];
        const note =
          remote.silentPeers.length > 0
            ? `\n(${remote.silentPeers.join(", ")} didn't answer — its agents are unknown right now, not absent.)`
            : "";
        return reply(formatDirectory(combined) + note);
      }

      if (name === undefined || !name.trim()) return reply(`agents ${action} needs a name.`);
      const trimmedName = name.trim();
      const found =
        state && Object.hasOwn(state.entries, trimmedName)
          ? state.entries[trimmedName]
          : state
            ? Object.entries(state.entries).find(([k]) => k.toLowerCase() === trimmedName.toLowerCase())?.[1]
            : undefined;

      if (action === "pin" || action === "unpin") {
        if (!found) return reply(`No agent named ${name}. Ask a human to register one.`);
        const targetKey =
          state && Object.hasOwn(state.entries, trimmedName)
            ? trimmedName
            : Object.keys(state?.entries ?? {}).find((k) => k.toLowerCase() === trimmedName.toLowerCase()) ?? trimmedName;
        const updated = await api.commit(
          async (tx) => (action === "pin" ? pinAgent(tx, targetKey) : unpinAgent(tx, targetKey)),
          context
        );
        if (!updated) return reply(`No agent named ${name}.`);
        // Refresh the passive hint cache in the same operation as the durable mutation.
        writeAgentsMirror(home, await api.snapshot(AgentsDoc, context));
        return reply(`${action === "pin" ? "Pinned" : "Unpinned"} ${targetKey}.`);
      }

      // send
      if (message === undefined || !message.trim()) return reply("agents send needs a message.");

      const now = Date.now();
      const senderMeta = await api.snapshot(MetaDoc, api.conversationId, context);
      if (agentMessageRateLimited(senderMeta?.agentMessagesSentAt, now)) {
        return reply(
          `Refused: this conversation has sent ${AGENT_MESSAGE_BUDGET} agent messages in the last hour. ` +
            `Wait before sending more so two agents cannot loop.`
        );
      }

      const chargeBudget = async () => {
        await api.commit(async (tx) => {
          const meta = await tx.doc(MetaDoc, api.conversationId);
          meta.agentMessagesSentAt = [...pruneAgentMessages(meta.agentMessagesSentAt, now), now];
        }, context);
      };

      // Resolution order: the caller's own crew first, then the registered directory, then a
      // unique local session title, then configured peer hosts.
      const crew = await api.snapshot(SessionsDoc, api.conversationId, context);
      const crewTarget = crew ? findCrewTarget(crew.items, trimmedName) : undefined;
      if (crewTarget) {
        const label = crewTarget.entry.title || crewTarget.key;
        const queued = followUp === true;
        const handle = await api.conversation(crewTarget.entry.conversationId, context);
        if (!handle) return reply(`Session ${label} is gone.`, crewTarget.entry.conversationId);
        const sent = await submitCrewMessage(api, handle, crewTarget.key, crewTarget.entry, message, queued, context);
        if (sent) await chargeBudget();
        return reply(`${queued ? "Queued for" : "Sent to"} ${label}.`, crewTarget.entry.conversationId);
      }

      if (found) {
        const handle = await api.conversation(found.conversationId as ConversationId, context);
        if (!handle) {
          return reply(
            `Agent ${name} is gone (conversation ${found.conversationId}); ask a human to register a replacement.`
          );
        }
        await handle.submit(
          {
            type: "input",
            content: message,
            whenBusy: followUp === true ? "followUp" : "steer",
            requestId: agentMessageRequestId(api.conversationId, trimmedName, api.taskId),
          },
          context
        );
        await chargeBudget();
        return reply(`Sent to ${name}.`, found.conversationId);
      }

      // Check if the name is in another leader's crew before falling back to session titles.
      const foreign = await foreignCrewEntry(api, trimmedName, context);
      if (foreign) {
        const label = foreign.entry.title || foreign.key;
        return reply(
          `Refused: ${label} is in another leader's crew (conversation ${foreign.lead}), so only ` +
            "that leader can message it. Spawn your own worker, or message a registered agent."
        );
      }

      // Try non-worker local conversations by title (including auto-derived titles).
      const byTitle = await titleMatchedConversations(api, trimmedName, context);
      if (byTitle.length > 1) {
        return reply(
          `Refused: more than one conversation is titled "${trimmedName}" (${byTitle.map((c) => `conversation ${c.id}`).join(", ")}).`
        );
      }
      if (byTitle.length === 1) {
        const match = byTitle[0];
        const handle = await api.conversation(match.id, context);
        if (handle) {
          await handle.submit(
            {
              type: "input",
              content: message,
              whenBusy: followUp === true ? "followUp" : "steer",
              requestId: agentMessageRequestId(api.conversationId, trimmedName, api.taskId),
            },
            context
          );
          await chargeBudget();
          return reply(`Sent to ${match.title}.`, match.id as number);
        }
      }

      // Federated peer lookup: `host/name` or bare `name` across configured peer hosts.
      if (peers.length > 0) {
        const slash = trimmedName.indexOf("/");
        const wantedHost = slash > 0 ? trimmedName.slice(0, slash).trim().toLowerCase() : null;
        const wantedAgent = slash > 0 ? trimmedName.slice(slash + 1).trim() : trimmedName;
        const candidatePeers = wantedHost
          ? peers.filter(
              (p) => p.label.toLowerCase() === wantedHost || p.id.toLowerCase() === wantedHost
            )
          : peers;
        const remoteMatches: Array<{ peer: PeerEndpoint; agent: DirectoryEntry }> = [];
        const silentPeers: string[] = [];
        await Promise.all(
          candidatePeers.map(async (peer) => {
            try {
              const response = await fetch(`${peer.url.replace(/\/+$/, "")}/directory`, {
                headers: { authorization: `Bearer ${peer.token}` },
                signal: AbortSignal.timeout(4_000),
              });
              if (!response.ok) {
                silentPeers.push(peer.label);
                return;
              }
              const body = (await response.json().catch(() => null)) as { agents?: DirectoryEntry[] } | null;
              for (const entry of Array.isArray(body?.agents) ? body.agents : []) {
                if (
                  entry.name.toLowerCase() === wantedAgent.toLowerCase() ||
                  (entry.title && entry.title.toLowerCase() === wantedAgent.toLowerCase())
                ) {
                  remoteMatches.push({ peer, agent: entry });
                }
              }
            } catch {
              silentPeers.push(peer.label);
            }
          })
        );
        if (remoteMatches.length > 1) {
          const candidates = remoteMatches.map((m) => `${m.peer.label}/${m.agent.name}`).join(", ");
          return reply(
            `Refused: "${wantedAgent}" exists on multiple hosts (${candidates}). Specify the host as host/name.`
          );
        }
        if (remoteMatches.length === 1) {
          const { peer, agent } = remoteMatches[0];
          const senderTitle = senderMeta?.title?.trim() || `conversation-${api.conversationId}`;
          try {
            const response = await fetch(`${peer.url.replace(/\/+$/, "")}/directory/send`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${peer.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                name: agent.name,
                message,
                followUp: followUp === true,
                senderHost: "remote",
                senderName: senderTitle,
                requestId: agentMessageRequestId(api.conversationId, `${peer.id}/${agent.name}`, api.taskId),
              }),
              signal: AbortSignal.timeout(6_000),
            });
            if (!response.ok) {
              const errBody = (await response.json().catch(() => null)) as { error?: string } | null;
              return reply(
                errBody?.error ?? `${peer.label} refused the message to ${agent.name} (${response.status}).`
              );
            }
            await chargeBudget();
            return reply(`Sent to ${peer.label}/${agent.name}.`, agent.conversationId);
          } catch {
            return reply(`${peer.label} didn't answer while sending to ${agent.name} — try again once it is back.`);
          }
        }
        if (silentPeers.length > 0) {
          return reply(
            `${silentPeers.join(", ")} didn't answer, so its agents are unknown right now — not absent. Try again once it is back.`
          );
        }
      }

      const known = listAgents(state).map((entry) => entry.name);
      return reply(
        `No agent named ${name}.${known.length > 0 ? ` Known agents: ${known.join(", ")}.` : ""} ` +
          "Only a human can register an agent."
      );
    },
  });

/** The `agents` tool + passive `known_agents` section, installed as one extension. */
export const agentsExtension = (home: string): Extension => ({
  name: "agents",
  tools: [createAgentsTool(home)],
  sections: [knownAgentsSection(home)],
});
