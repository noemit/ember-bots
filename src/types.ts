import type { ToolDisplay } from './lib/toolDisplay';
/** `pi` endpoints are Hearth hosts (the transition target); the rest are OpenChamber. */
export type InstanceKind = 'local' | 'remote' | 'ssh' | 'relay' | 'pi';

export type InstanceStatus = 'checking' | 'ready' | 'unreachable' | 'unsupported';

export type PiEndpoint = {
  id: string;
  label: string;
  url: string;
  /**
   * Bearer token for every request; Hearth generates it, Ember stores it here.
   *
   * Empty on the remote surface: a remote browser gets no token, only `hasToken`. Never treat an
   * empty token as "no token configured" — check `hasToken` when it is present.
   */
  token: string;
  /** Present on the remote surface; `false` there means the desktop has no token stored either. */
  hasToken?: boolean;
};

export type Instance = {
  id: string;
  label: string;
  kind: InstanceKind;
  url?: string;
  status: InstanceStatus;
  attachable: boolean;
  /** Hearth build id (git SHA) from `/health`, for pi endpoints. */
  version?: string;
};

export type Project = {
  id: string;
  name: string;
  path?: string;
  /** Epoch ms the project was last opened in OpenChamber; used for new-session suggestions. */
  lastOpenedAt?: number;
};

export type ModelRef = {
  providerID: string;
  modelID: string;
  /** Reasoning-effort variant selected for the next turn. */
  variant?: string;
};

export type InstanceDefaults = {
  directory?: string;
  model?: ModelRef;
  /** Reasoning-effort variant for the default model, e.g. 'high'. */
  variant?: string;
  bypass?: boolean;
  /**
   * Underline colour for sessions from this instance. Absent means "automatic" — a stable colour
   * derived from the instance id — because the underline is how you tell which Hearth a session is
   * running on, and an unmarked rail is ambiguous. `-1` turns it off explicitly.
   */
  markerColor?: number;
  /**
   * Prefer one provider's models on this instance, resolving the concrete model from whatever the
   * instance actually lists. A stored `model` above always wins; this is the softer rule for "use
   * my subscription" without pinning an id that may not exist on the next device.
   */
  preferredProvider?: string;
};

export type NewSessionOptions = {
  instanceId: string;
  directory: string;
  model?: ModelRef;
  variant?: string;
  /** Standing instructions the new session starts with (its own section of the system prompt). */
  instructions?: string;
  bypass: boolean;
};

export const modelRefKey = (ref: ModelRef): string => `${ref.providerID}/${ref.modelID}`;
export const DEFAULT_MODEL = 'default';

/**
 * A process a session's commands left running (Hearth's `processes` field, `src/processes.ts`).
 *
 * This file keeps its own copy of the wire shapes it needs, like the rest of `types.ts`: the
 * renderer's tsconfig root is separate from the main process's, and importing from `lib/piMapping`
 * here would make the two modules import each other.
 */
export type LeftProcess = {
  pid: number;
  command: string;
  rssBytes: number;
  /** Epoch ms when the process started. */
  startedAt: number;
};

/** A session's leftovers as the list carries them: the total, and the heaviest few. */
export type SessionProcesses = {
  count: number;
  rssBytes: number;
  items: LeftProcess[];
};

/** What a stop did to one process. `refused` means it took SIGTERM and is still there. */
export type ProcessStopOutcome = 'stopped' | 'gone' | 'refused';

export type ProcessStopResult = {
  pid: number;
  command?: string;
  outcome: ProcessStopOutcome;
};

/** The machine's memory, with the level that decides how loud the notice is. */
export type HostMemory = {
  totalBytes: number;
  availableBytes: number;
  level: 'normal' | 'low' | 'critical';
};

export type Session = {
  id: string;
  instanceId: string;
  title?: string;
  directory?: string;
  updated?: number;
  /** Model the session last ran with, as reported by the instance. */
  model?: ModelRef;
  /** Agent the session last ran with, as reported by the instance. */
  agent?: string;
  /** USD the session has spent, from the host's own usage ledger. Absent where the host has none. */
  cost?: number;
  /** Epoch ms when the session was archived on its OpenChamber instance; unset/0 means active. */
  archived?: number;
  /** Set on subagent sessions spawned by another session (OpenCode's `parentID`). */
  parentId?: string;
  /**
   * Coagent role on Hearth: a leader's hidden `worker` (never in the rail, shown only in its
   * leader's crew strip) or an addressable `peer` (a promoted worker; an ordinary visible
   * session). Absent on plain sessions, including OpenChamber ones.
   */
  kind?: 'worker' | 'peer';
  /** The immediate leader a worker reports to, as an Ember instance/session pair. */
  lead?: { instanceId: string; sessionId: string };
  /**
   * Set on a worker once a human promoted it: the peer conversation's id (stringified like
   * `id`), living on the same `instanceId`. The strip renders such a row as a peer link.
   */
  promotedTo?: string;
  /** Server-computed: the conversation has a pending approval or question. */
  needsInput?: boolean;
  /** Whether this session offers the delegation tool (can lead a crew). */
  delegates?: boolean;
  /** True while a context compaction task is in flight (Hearth's `pi.live.compactions`). */
  compacting?: boolean;
  /** The newest compaction failure reported by the host (`pi.live.compactionFailure`). */
  compactionFailure?: {
    taskId?: number;
    trigger?: string;
    error: string;
  };
  /**
   * The newest Hearth entry id in the conversation, from its summary. Message ids are `e<entryId>`,
   * so this is what tells Home whether a session can hold anything unread *without* reading it.
   * Absent on OpenChamber instances, which have no entry ordinals.
   */
  lastEntryId?: number;
  /**
   * Programs this session's commands left running (Hearth only; absent otherwise). Present only
   * when there are some, so a session that behaves carries nothing: it is what the column's
   * "still running" notice is drawn from, with the Stop beside it.
   */
  processes?: SessionProcesses;
  /**
   * The host's memory as it came with the same answer. Repeated on each of a host's rows because it
   * arrives with the session list rather than per conversation, and a column reads it with the
   * session it renders; the object is the same reference for every row of one poll.
   */
  hostMemory?: HostMemory;
};

/**
 * Per-message read state for one session (see `lib/readState.ts`).
 *
 * `through` is an entry ordinal: everything at or below it is read. `ids` holds messages marked out
 * of order until the run under them closes. `readAt` is the fallback for wires without ordinals,
 * and `comments` counts comment sets sent from Ember on this session.
 */
export type SessionReadMark = {
  through: number;
  ids?: number[];
  readAt?: number;
  comments?: number;
  /**
   * "Mark all messages as read; no notifications needed": a standing policy for this session, not a
   * mark. The newest message advances `through` on arrival, so it never accumulates a backlog.
   */
  quiet?: boolean;
};

export type SessionRef = {
  instanceId: string;
  sessionId: string;
};

/** Stable key for a session across instances (session ids are only unique per instance). */
export const sessionKey = (ref: SessionRef | Session): string =>
  `${ref.instanceId}::${'sessionId' in ref ? ref.sessionId : ref.id}`;

/**
 * What the host last said about a session.
 *
 * `unknown` is a real answer: no status has arrived for the session's instance yet (Ember just
 * started, the host is restarting, the instance is unreachable, or the last read failed). It is
 * deliberately part of the state rather than an absent key, because every consumer would otherwise
 * have to invent an answer — and the one it used to invent, `idle`, is the one that makes a working
 * agent look asleep.
 */
export type BallState = 'idle' | 'active' | 'needs-input' | 'error' | 'unknown';

/**
 * What the blob should look like. Splits the server's coarse ball state into the distinct moods a
 * session can be in: `busy` (tools running) vs `thinking` (reasoning), and `input` (permission)
 * vs `question` (the agent asked something). `unknown` has no host answer behind it and draws
 * neutral: it is a distinct visual precisely so it cannot be read as idle.
 */
export type BallMood =
  | 'idle'
  | 'busy'
  | 'thinking'
  | 'input'
  | 'question'
  | 'error'
  | 'unread'
  | 'unknown';

/** Where the open session's transcript is: first fetch in flight, failed (poll keeps retrying), or loaded. */
export type MessagesStatus = 'loading' | 'error' | 'ready';

export type BlobStyle = 'buddy' | 'crystal' | 'pip' | 'lava';

/** Width the session list can take: a blob dock, the familiar rail, or about half the window. */
export type RailMode = 'mini' | 'normal' | 'wide';

/** How assistant thinking blocks render: fully open, collapsed rows, or not at all. */
export type ReasoningDisplay = 'expanded' | 'collapsed' | 'hidden';

export type AvatarOverride = {
  colorIndex?: number;
  shapeName?: string;
};

export type AvatarIdentity = {
  sessionKey: string;
  projectKey?: string;
  taskKey?: string;
  colorSeed: string;
  shapeSeed: string;
  motionSeed: string;
  colorIndex?: number;
  shapeName?: string;
};

export type ToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'interrupted';

/**
 * One tool call a `codemode` script made while it ran (`tools.read(...)`, an MCP tool, …).
 *
 * The host reports these twice: live, under `pi.live.nestedTools`, while the script is still
 * running, and once more as `details.calls` on the script's settled result. Both are normalized
 * onto this shape, so the row can draw the same list before and after the call ends.
 *
 * `status` is the nested call's own outcome, not the outer call's: `running` for a call still in
 * flight, `ok`/`error` once it returned, `cancelled` when the script or its call was stopped.
 */
export type NestedToolCall = {
  /** The key the host gave the call (`c1`, `c2`), stable while the script runs. */
  id: string;
  name: string;
  /** Compact JSON of the arguments, as the host reports them (already cut for display). */
  args: string;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  durationMs?: number;
  error?: string;
};

export type ToolCall = {
  id: string;
  tool: string;
  status: ToolStatus;
  /** Server-provided summary of the call, e.g. the bash command or file path. */
  title?: string;
  error?: string;
  input?: Record<string, unknown>;
  /** Tool output, truncated by the API layer so a chatty command can't bloat the transcript. */
  output?: string;
  /** Unified diff for edit/write tools when the server provides one. */
  diff?: string;
  /** Images the tool returned (the `view` tool, MCP screenshots) — shown inline in the tool row. */
  images?: FileAttachment[];
  /**
   * The tool calls a `codemode` script made, in the order it made them. Live while it runs (from
   * `pi.live.nestedTools`), then settled from the result's `details.calls`. Absent on every other
   * tool, and on a script that called nothing.
   */
  nestedCalls?: NestedToolCall[];
  /**
   * A temp file holding a script's complete output, when the host cut it to its token budget. Only
   * `codemode` reports one.
   */
  fullOutputPath?: string;
  /**
   * What the command exited with, when the host reports it (`bash`'s `structuredOutput`). It is the
   * answer for a `grep`-shaped command — exit 1 means "no match", not "broken" — so the row shows it
   * rather than asking a reader to infer it from a red row.
   */
  exitCode?: number;
  /**
   * True when the host dropped earlier output (it keeps the tail: 2 000 lines or 50 KB). Without it
   * a short log reads as the whole log.
   */
  truncated?: boolean;
};

export type FileAttachment = {
  filename: string;
  mime: string;
  /** `data:` URL for outgoing attachments; whatever the server stored for history. */
  url: string;
};

/** Message content in the order it was produced; text, reasoning, files and tool calls interleave. */
export type MessagePart =
  | { type: 'text'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'file'; id: string; file: FileAttachment }
  | { type: 'tool'; id: string; call: ToolCall };

/** Provider-reported token usage for an assistant turn; `cache` is prompt caching. */
export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  /** Concatenated text parts, kept for previews and search. */
  text: string;
  parts: MessagePart[];
  model?: ModelRef;
  tokens?: TokenUsage;
  /** Provider-reported USD cost for this assistant turn, when the API includes it. */
  cost?: number;
  error?: string;
  /** The error is a user-initiated stop, not a failure; don't surface it as an error state. */
  aborted?: boolean;
  createdAt?: number;
  completedAt?: number;
  /** False while the assistant is still producing this message. */
  completed: boolean;
  /**
   * Client-only delivery state for an optimistic *user* message. `sending` means the request is
   * still in flight, `queued` means the server answered that it holds the message and will place
   * it at the turn's next boundary, `unconfirmed` means the server said it placed the message but
   * the transcript's echo of it has not landed yet, and `failed` means a definite failure (a
   * transport error, a non-2xx response, or a refused submission) with the ways out: send again,
   * copy, discard. Only `unconfirmed` is ever doubted, and only after `UNCONFIRMED_SEND_MS` in
   * silence; a `queued` message is held by the host and is never turned into a doubt. Never set on
   * server messages, never persisted, never sent over the wire.
   */
  delivery?: 'sending' | 'queued' | 'unconfirmed' | 'failed';
  /** Why a `failed` send failed (client-only, shown on the bubble next to the retry actions). */
  deliveryError?: string;
  /**
   * Client-only: a one-line note for a bubble whose delivery state is true but incomplete. Today
   * that is only a message held on a new-agent draft ("Sends once this session has started."),
   * which is waiting for a conversation rather than for the host to take it.
   */
  deliveryNote?: string;
  /**
   * Client-only: this assistant message is Hearth's in-flight generation (`pi.live`), not a
   * settled entry. It carries the reasoning and text streaming right now; the durable entry that
   * replaces it carries the same parts, so nothing the user watched is lost.
   */
  live?: boolean;
};

export type PermissionReply = 'once' | 'always' | 'reject';

export type PermissionRequest = {
  id: string;
  instanceId: string;
  sessionId: string;
  /** Directory scope that returned this request, used to route the reply. */
  directory?: string;
  /** Tool or capability being requested, e.g. `bash`, `edit`, `webfetch`. */
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
};

export type QuestionOption = {
  label: string;
  description: string;
  /** Form option `value` sent back in the answer; falls back to the label when unset. */
  value?: string;
};

export type QuestionInfo = {
  /** Short tab label, e.g. "Auth method". */
  header: string;
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
  /** Whether a free-text answer is allowed. OpenCode defaults this to true. */
  custom?: boolean;
  /** Form field key — OpenCode 2 answers are a map keyed by field, not an array. */
  key?: string;
  /** Form field type, used to coerce the collected strings back into a `Form.Value`. */
  valueType?: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external';
};

export type QuestionRequest = {
  id: string;
  instanceId: string;
  sessionId: string;
  /** Directory scope that returned this request, used to route the reply. */
  directory?: string;
  questions: QuestionInfo[];
};

/** One answer per question: the chosen option labels, or a single custom string. */
export type QuestionAnswers = string[][];

export type QueuedMessageSendConfig = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

export type QueuedMessageAttachment = {
  id?: string;
  filename: string;
  mimeType: string;
  size?: number;
  source?: string;
  /** Full payload, present when an item is taken for immediate sending or editing. */
  dataUrl?: string;
};

export type QueuedMessageContext = {
  kind: string;
  text: string;
  metadata?: Record<string, unknown>;
  instructions?: string;
};

export type QueuedMessage = {
  id: string;
  createdAt: number;
  content: string;
  text: string;
  attachments: QueuedMessageAttachment[];
  context: QueuedMessageContext[];
  sendConfig: QueuedMessageSendConfig;
  agentMention?: string;
  /**
   * How the instance will dispatch this row: a follow-up waits its turn, a steer joins the running
   * turn at its next boundary. Absent means follow-up (that is what the queue holds).
   */
  mode?: 'follow-up' | 'steer';
  /** Local only: the item is still being enqueued on the instance (show a loader). */
  pending?: boolean;
  /** Local only: enqueue failed; show the error with retry/cancel. */
  error?: string;
};

export type MessageQueueSession = {
  sessionId: string;
  directory: string;
  items: QueuedMessage[];
  sendingId: string | null;
};

export type MessageQueueSnapshot = {
  revision: number;
  sessions: MessageQueueSession[];
};

export type MessageQueueMutation = {
  revision: number;
  session: MessageQueueSession;
  itemId?: string;
};

export type MessageQueueTakeMutation = MessageQueueMutation & {
  /** Full queued payload, including attachment data URLs and captured context. */
  item: QueuedMessage;
};

export type ModelDetails = {
  name: string;
  providerName: string;
  family?: string;
  releaseDate?: string;
  /** 'active' | 'beta' | 'deprecated' | … as reported by the provider catalogue. */
  status?: string;
  contextTokens?: number;
  outputTokens?: number;
  /** USD per million tokens. */
  costInput?: number;
  costOutput?: number;
  reasoning: boolean;
  toolcall: boolean;
  attachment: boolean;
  /** Input modalities beyond text, e.g. ['image', 'pdf']. */
  inputs: string[];
  /** Reasoning-effort variants the model accepts, e.g. ['low', 'high']. */
  variants: string[];
};

export type ModelOption = ModelRef & {
  label: string;
  details: ModelDetails;
};

export type SessionNote = {
  id: string;
  text: string;
};

export type StoredComposerDraft = {
  text: string;
  modelId?: string;
  variant?: string;
  updatedAt: number;
};

export type EmberSettings = {
  theme: string;
  blobStyle: BlobStyle;
  /** Only list sessions active within this many hours; 0 means show everything. */
  sessionWindowHours: number;
  /**
   * Instances the person switched off in the top bar's Instances menu. A hidden host's sessions,
   * outage row and palette entries are all filtered out — and, unlike the in-memory set this used
   * to be, the choice survives a relaunch.
   */
  hiddenInstances: string[];
  /**
   * Hosts whose "Not answering" row the person dismissed. A dismissal is cleared when that host
   * answers again (so the next outage warns), never by a relaunch; see
   * `lib/instanceHealth.ts` `reconcileOutageDismissals`.
   */
  dismissedOutages: string[];
  /** Collapse tool-call rows out of the transcript. */
  hideToolCalls: boolean;
  reasoningDisplay: ReasoningDisplay;
  /** Show the question & answer (`ask`) blocks. */
  showQuestions: boolean;
  /** Open tool rows expanded instead of on click. Meaningless while tool use is hidden. */
  expandToolCalls: boolean;
  /**
   * Whether a turn's tool calls are listed one by one, or folded behind one line.
   *
   * `list` draws a row per tool group, as the transcript always did. `collapsed` folds every call
   * in the turn into "Using tools (3)…", whose count grows as the turn runs, with the usual list
   * behind a click — for a reader who wants the prose without scrolling past twenty rows of tools.
   *
   * The third state the menu offers, "List all tools", is not a third value here: it is `list`
   * with nothing else to say, so the mode is the only thing stored.
   */
  toolDisplay: ToolDisplay;
  /** The per-turn footer: model, duration, tokens, cost, received time. */
  showMessageDetails: boolean;
  /** The session blob beside the latest turn. */
  showAvatars: boolean;
  /** The transcript's scrub rail; hidden automatically on short chats. */
  showActivityRail: boolean;
  /** Agent groups: named, cross-instance sets of `instance::session` keys. */
  sessionGroups: SessionGroup[];
  compactSpacing: boolean;
  /** Tighter session rows in the rail. */
  compactRail: boolean;
  /**
   * How wide the session list is: `mini` is a 64px dock of blobs (the icon-sized collapse),
   * `normal` is the familiar 320px rail, and `wide` is about half the window so each row can show
   * the latest message. Remembered across restarts.
   */
  railMode: RailMode;
  /** Pin the transcript to the bottom while a reply streams. */
  autoFollow: boolean;
  /**
   * Whether opening a session sits beside the one already open instead of replacing it.
   *
   * Off (the default) there is one column: clicking a row takes the view over, and closing or
   * minimizing a session simply returns it to the rail. On, as many columns as fit stay open side
   * by side — the old tab-strip behaviour, minus the strip: nothing is hidden behind a tab.
   */
  splitView: boolean;
  instanceDefaults: Record<string, InstanceDefaults>;
  sessionNotes: Record<string, SessionNote[]>;
  /** Per-message read state, by session key. Survives restarts; see `lib/readState.ts`. */
  readMarks: Record<string, SessionReadMark>;
  /**
   * Epoch ms of the first launch that understood read marks: anything older counts as read, so an
   * upgrade doesn't open Home with every message ever written flagged unread. Absent means this
   * launch is that launch.
   */
  readSince?: number;
  composerDrafts: Record<string, StoredComposerDraft>;
  scheduledSessionBindings: Record<string, string>;
  /** Archive finished scheduled-task runs once they're a day old. */
  autoArchiveScheduledRuns: boolean;
  avatarOverrides: Record<string, AvatarOverride>;
  projectColorAssignments: Record<string, number>;
  /** Workspace: ordered open session keys ("instance::session"). */
  openSessions: string[];
  activeSession: string | null;
  /** Manually minimized sessions; sticky across resizes and restarts. */
  minimizedSessions: string[];
  /** Hearth endpoints: the pi transition target. */
  piEndpoints: PiEndpoint[];
  remoteAccessEnabled: boolean;
  remotePasswordConfigured: boolean;
  /**
   * Whether the remote listener is actually bound, and where. `remoteAccessEnabled` is a wish;
   * this is the fact the UI must render, so a toggle can never claim "On" over an unbound socket.
   */
  remoteAccessState?: RemoteAccessState;
  /** True when `settings.json` was unreadable and was moved aside; the user should be told. */
  settingsRecovered?: boolean;
};

export type RemoteStatus = 'off' | 'starting' | 'listening' | 'no-tailscale' | 'error';

export type RemoteAccessState = {
  status: RemoteStatus;
  address?: string;
  port?: number;
  detail?: string;
  attempts: number;
  changedAt: number;
};

export type EmberSettingsPatch = Partial<EmberSettings> & {
  composerDraftChanges?: Record<string, StoredComposerDraft | null>;
  /** Plaintext is accepted only transiently and is hashed by Electron before persistence. */
  remotePassword?: string | null;
};

/** The transcript/rail display controls the eye menu edits (a slice of `EmberSettings`). */
export type SessionGroup = {
  id: string;
  name: string;
  keys: string[];
  primaryKey?: string;
};

export type ViewSettings = {
  reasoningDisplay: ReasoningDisplay;
  hideToolCalls: boolean;
  showQuestions: boolean;
  expandToolCalls: boolean;
  toolDisplay: ToolDisplay;
  showMessageDetails: boolean;
  showAvatars: boolean;
  showActivityRail: boolean;
  compactSpacing: boolean;
  compactRail: boolean;
  autoFollow: boolean;
  splitView: boolean;
};

export type ViewSettingsPatch = Partial<ViewSettings>;

export const SESSION_WINDOWS: Array<{ hours: number; label: string }> = [
  { hours: 5, label: 'Last 5 hours' },
  { hours: 24, label: 'Last day' },
  { hours: 48, label: 'Last 2 days' },
  { hours: 120, label: 'Last 5 days' },
  { hours: 24 * 14, label: 'Last 2 weeks' },
  { hours: 0, label: 'All time' },
];

/**
 * An invalidation hint from an instance's event stream. Bodies are stripped in the main
 * process; the renderer refetches what the hint points at. `ember:stream-status` is synthetic
 * and says whether the instance's stream is live (so polling can back off).
 *
 * The one bounded exception: whitelisted milestone events carry a short, display-ready
 * `summary` (plus capped `detail` scalars) that main extracted for the activity log. `id`
 * and `at` identify and order log entries; older bridges may omit all four.
 */
/** One append to the in-flight assistant message, as the stream carries it. Bounded on both ends. */
export type LiveDelta = { index: number; kind: 'text' | 'thinking'; text: string };

export type EmberEvent = {
  instanceId: string;
  type: string;
  sessionId?: string;
  directory?: string;
  connected?: boolean;
  /** Stable upstream event id, or a synthesized one; de-dupes live entries against history. */
  id?: string;
  /** When the event happened (the envelope's `created`), else when Ember received it. */
  at?: number;
  summary?: string;
  detail?: Record<string, string>;
  /**
   * Appends to the in-flight message, present only when the transport could reduce the frame to
   * pure appends. Absent means "ask REST" — the same path as before this existed.
   */
  deltas?: LiveDelta[];
};

/**
 * One durable activity-log entry, as persisted by main (`electron/activity.ts`) and served
 * back through the bridge. `summary`/`detail` are the bounded strings `describeEvent`
 * extracted from the event payload — no transcript content ever rides here.
 */
export type ActivityEntry = {
  id: string;
  /** Epoch ms — the event's own time when the stream carried it, else receive time. */
  at: number;
  instanceId: string;
  directory?: string;
  sessionId?: string;
  type: string;
  summary: string;
  detail?: Record<string, string>;
};

export type ActivityQuery = {
  /** One local day (`YYYY-MM-DD`); omit for newest-first across every retained day. */
  day?: string;
  from?: number;
  to?: number;
  limit?: number;
  /** Opaque continuation token from a previous page. */
  cursor?: string;
};

export type ActivityPage = { entries: ActivityEntry[]; cursor?: string };

export type EmberBridge = {
  /** Display name — "Ember Canary" when this build runs with its own `EMBER_DATA_DIR`. */
  appName?: string;
  getModelStats?(): Promise<import('./lib/modelStats').ModelObservation[]>;
  observeModels?(observations: import('./lib/modelStats').ModelObservation[]): Promise<import('./lib/modelStats').ModelObservation[]>;
  clearModelStats?(): Promise<void>;
  /**
   * The durable activity log (one JSONL day file per local day in `~/.config/ember/activity`).
   * Entries are the bounded event summaries main extracted; nothing else about a payload
   * crosses the bridge. Optional: an older remote server may not serve them.
   */
  activityList?(query: ActivityQuery): Promise<ActivityPage>;
  activitySearch?(query: string, range?: ActivityQuery): Promise<ActivityPage>;
  activityDays?(): Promise<string[]>;
  activityClear?(): Promise<void>;
  capabilities?: { dockIcon: boolean; appIcon?: boolean };
  listInstances(refresh?: boolean): Promise<unknown>;
  getSettings(): Promise<EmberSettings>;
  setSettings(patch: EmberSettingsPatch): Promise<EmberSettings>;
  /** Open an http(s) URL in the default browser or reveal a local path in Finder. */
  openExternal(target: string): Promise<boolean>;
  /** The packaged Ember version, shown in Settings so an upgrade can be checked at a glance. */
  appVersion?(): Promise<string>;
  /** Check GitHub for a newer release of Ember. */
  checkForUpdate?(): Promise<{
    updateAvailable: boolean;
    currentVersion: string;
    latestVersion: string | null;
    releaseUrl: string;
  }>;
  /** Replace the Dock icon with a PNG data URL (macOS only; a no-op elsewhere). */
  setAppIcon(dataUrl: string): Promise<{ ok: boolean; reason?: string }>;
  /** Carry a failure that happened before the IPC into the same log; absent on older bridges. */
  reportAppIconIssue?(reason: string): Promise<{ ok: boolean }>;
  /**
   * One formatted line into `ember-compact.log`. A compaction the host accepts and does not perform
   * leaves no other trace, so the attempt has to be written down somewhere.
   */
  reportCompaction?(line: string): Promise<{ ok: boolean }>;
  request(
    instanceId: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ ok: boolean; status: number; data: unknown }>;
  /**
   * Subscribe to invalidation hints; returns an unsubscribe. Bridges that can't stream (an
   * older remote server) leave this undefined and the renderer stays on its polling cadence.
   */
  onEvent?(listener: (event: unknown) => void): () => void;
  /** Live status per instance at subscribe time. */
  eventStatus?(): Promise<Record<string, boolean>>;
  /**
   * Proxied request to a Hearth endpoint (`piEndpoints` in settings): `path` like
   * `/conversations`; `init` a fetch-like `{ method?, body? }`. Optional — the pi mock
   * implements it for dev:web and older bridges predate the transition.
   */
  piRequest?<T = unknown>(
    endpointId: string,
    path: string,
    init?: { method?: string; body?: unknown }
  ): Promise<{ ok: boolean; status: number; data: T }>;
};

declare global {
  interface Window {
    ember: EmberBridge;
  }
}
