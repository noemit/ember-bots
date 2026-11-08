/**
 * The pi mock: an in-memory Hearth for `bun run dev:web`. It serves the same wire the real
 * host does (`piRequest`), emits the same `pi:<event>` invalidation hints main forwards,
 * parks approvals and questions the same way, and scripts faux turns (text, tool calls,
 * slow runs, steer) so the UI can be built against pi semantics before Hearth moves.
 *
 * The legacy OpenCode mock stays reachable at `?legacy` (see `src/dev/mockBridge.ts`).
 */
import { longDemoPrompt, longDemoReview, longDemoFollowUp } from './longMessages';
import { parseAvatarOverrides } from '../../electron/transport';
import { generateToken } from '../../electron/tokenWords';
import type { EmberBridge, EmberSettings, EmberSettingsPatch, Instance } from '../types';

const ENDPOINT_ID = 'pi:hearth';
const ENDPOINT: Instance = {
  id: ENDPOINT_ID,
  label: 'ember-harness (mock)',
  kind: 'pi',
  url: 'http://127.0.0.1:3002',
  status: 'ready',
  attachable: true,
};

/**
 * `?outage` adds a second endpoint that is down. Nothing else in the mock can produce an
 * unreachable host, so the rail's "Not answering" row — and its Dismiss control — had no way to be
 * seen in a browser at all. It is `attachable: false` exactly like a real host that stopped
 * answering, so App lists its sessions as last-known rather than asking it again.
 */
const outageFixture = new URLSearchParams(window.location.search).has('outage');
/**
 * `?fixture=firstrun` serves an empty world: no instance answering, nothing configured.
 *
 * The first-run guide exists for the state that is hardest to reproduce — nothing works yet — and
 * the mock normally supplies a healthy host for every other screen's sake. This is the one switch
 * that lets the guide be exercised (and e2e-tested) without a real broken install.
 */
const fixtureParam = new URLSearchParams(window.location.search).get('fixture');
const firstRunFixture = fixtureParam === 'firstrun';
/**
 * `?fixture=onboarding` is a healthy install whose guide has not been dismissed yet.
 *
 * The opposite of `firstrun`: here everything works, so the guide should show *five* steps (no
 * container instructions) and open on the provider step. Both paths need to be reachable in a
 * browser, or only one of them ever gets looked at.
 */
const onboardingFixture = fixtureParam === 'onboarding';
const OUTAGE_ENDPOINT: Instance = {
  id: 'pi:studio',
  label: 'Studio Mac',
  kind: 'pi',
  url: 'http://127.0.0.1:3009',
  status: 'unreachable',
  attachable: false,
};

type MockEntry = { id: number; kind: string; model?: Array<Record<string, unknown>> };

type MockApproval = {
  key: string;
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'once' | 'always' | 'reject';
};

type MockQuestion = {
  key: string;
  question: string;
  options: string[];
  status: 'pending' | 'answered' | 'cancelled';
  answer?: string;
};

type MockConversation = {
  id: number;
  cwd: string;
  title?: string;
  archived?: number;
  model: { provider: string; modelId: string };
  thinkingLevel?: string;
  autoAccept: { enabled: boolean; allowed: string[] };
  /** Coagent role: a hidden crew `worker`, or an addressable `peer`. */
  kind?: 'worker' | 'peer';
  /** The immediate leader; workers carry it, peers keep it as history. */
  lead?: { conversationId: number; host: string };
  /** Set on a worker once a human promoted it; the peer fork's conversation id. */
  promotedTo?: number;
  /** Whether the conversation offers the delegation tool + leader section. */
  delegates?: boolean;
  entries: MockEntry[];
  nextEntry: number;
  busy: boolean;
  /** True while a compaction task is in flight (manual, threshold or overflow). */
  compacting: boolean;
  approvals: MockApproval[];
  questions: MockQuestion[];
  inbox: Array<{ id: number; mode: 'steer' | 'followUp'; content: MockContent }>;
  nextSubmission: number;
  /** Set while a run is parked on an approval or question. */
  parked?: { kind: 'approval' | 'question'; callId: string; followUp?: () => void };
  /** Set while a long-running tool step is in flight, so a stop can interrupt it. */
  /**
   * A tool call that is executing. `output` is what the *host* streams while it runs: Hearth's bash
   * tool calls `api.output()` per chunk, keeps the retained tail in `pi.live`'s slot, and the
   * transcript shows it live. Absent means "running, nothing written yet".
   */
  runningTool?: { callId: string; tool: string; output?: string };
  /**
   * The in-flight generation, as Hearth keeps it in `pi.live.generation.message`: reasoning and text
   * accumulate here while the turn runs and only become a durable entry when it ends. This is what a
   * `docs=1` tail read sees mid-turn.
   */
  liveGeneration?: { provider: string; model: string; thinking: string; text: string };
  timers: number[];
};

const minutes = (n: number): number => Date.now() - n * 60_000;
const text = (value: string): Array<Record<string, unknown>> => [{ type: 'text', text: value }];
const thinking = (value: string): Array<Record<string, unknown>> => [
  { type: 'thinking', thinking: value, thinkingSignature: 'mock' },
];
const toolCall = (callId: string, name: string, args: Record<string, unknown>): Array<Record<string, unknown>> => [
  { type: 'toolCall', id: callId, name, arguments: args },
];
// `?modelDrift` records a different model on the assistant entries than the conversation carries —
// a session whose model was switched after the turn ran. The context meter has to say "unknown"
// for it: the measured turn belongs to another model, so there is no honest percentage.
const modelDriftFixture = new URLSearchParams(window.location.search).has('modelDrift');

const assistantMessage = (
  content: Array<Record<string, unknown>>,
  stopReason = 'stop',
  at = Date.now()
): Record<string, unknown> => ({
  role: 'assistant',
  content,
  api: 'mock',
  provider: 'faux-hearth',
  model: modelDriftFixture ? 'glm-4.6-legacy' : 'glm-5.3-flash',
  usage: { input: 820, output: content.length * 40, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0.0002 } },
  stopReason,
  timestamp: at,
});
const toolResult = (
  callId: string,
  name: string,
  output: string,
  isError = false,
  at = Date.now()
): Record<string, unknown> => ({
  role: 'toolResult',
  toolCallId: callId,
  toolName: name,
  content: text(output),
  isError,
  timestamp: at,
});
/** A user submission's content: text, or text with images — pi-ai's `UserMessage["content"]`. */
type MockContent = string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;

/** The plain text of a submission, for the scripted turn chooser. Images contribute nothing. */
const textOf = (content: MockContent): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join(' ');

const userMessage = (content: MockContent, at = Date.now()): Record<string, unknown> => ({
  role: 'user',
  // Real Hearth stores text-only user input as a plain string, not a block array.
  content,
  timestamp: at,
});

let conversationSequence = 3;
let entrySequence = 100;
let submissionSequence = 50;
let callSequence = 0;
const nextCallId = (): string => `call_${(callSequence += 1)}`;
const nextEntryId = (): number => (entrySequence += 1);
const nextSubmissionId = (): number => (submissionSequence += 1);

// `?staleBusy` simulates the client's stale idle read: a follow-up parks in the inbox server-side
// while the summary still reports idle, so the client only learns it was queued from the response.
// Exercises the send path that must reveal a queued message in the queue, never the transcript.
const staleBusyFixture = new URLSearchParams(window.location.search).has('staleBusy');

// `?promoted` adds a worker that a human already promoted (plus its peer), so the strip's
// peer-link row and the rail's newly visible peer can be exercised in dev:web without promoting.
const promotedFixture = new URLSearchParams(window.location.search).has('promoted');
/** `?compactNoop`: the host accepts a compaction and then does nothing at all. */
const compactNoopFixture = new URLSearchParams(window.location.search).has('compactNoop');

// `?unpricedCost` makes the mock's usage ledger total zero while its entries carry usage — the live
// anomaly the cost badge exists for (a model the provider doesn't price). It exercises the badge's
// "Cost unknown" state without a host that actually refuses to price anything.
const unpricedCostFixture = new URLSearchParams(window.location.search).has('unpricedCost');

// Submit fixtures for the send path: a bridge that answers slowly (a request stays in flight for
// as long as the real one may), and one that refuses. Both exist so the transcript's delivery row
// can be exercised without a live Hearth.
const SLOW_SUBMIT_MS = 24_000;
const slowSubmitFixture = new URLSearchParams(window.location.search).has('slowSubmit');
const failSubmitFixture = new URLSearchParams(window.location.search).has('failSubmit');

// Create fixtures for a new agent's draft. The create is the other slow round trip, and the one that
// used to leave the pane looking inert: `?slowCreate` holds the answer until the test says go (or
// eight seconds pass), `?failCreate` refuses like Hearth does for a folder that is not there, and
// `?dropCreate` creates the conversation but never delivers the answer — the ambiguous failure that
// must not become a second session on retry.
const SLOW_CREATE_MS = 8_000;
const slowCreateFixture = new URLSearchParams(window.location.search).has('slowCreate');
// Fails only the first create, so a retry can succeed: that is the flow the pane has to support
// (the folder was wrong, the person fixes the row, Try again starts the session).
const failCreateFixture = new URLSearchParams(window.location.search).has('failCreate');
let createAttempts = 0;
const dropCreateFixture = new URLSearchParams(window.location.search).has('dropCreate');
let createReleased = false;
let releaseCreateNow: (() => void) | null = null;
const waitForCreateRelease = async (): Promise<void> => {
  if (createReleased) return;
  await Promise.race([
    new Promise<void>((resolve) => {
      releaseCreateNow = resolve;
    }),
    new Promise<void>((resolve) => window.setTimeout(resolve, SLOW_CREATE_MS)),
  ]);
};
const releaseCreate = () => {
  createReleased = true;
  releaseCreateNow?.();
};

declare global {
  interface Window {
    emberCreateFixture?: { releaseCreate: () => void };
  }
}
if (slowCreateFixture) window.emberCreateFixture = { releaseCreate };

const makeConversation = (overrides: Partial<MockConversation> = {}): MockConversation => {
  // Named fixtures reserve explicit ids. New chats and promoted peers must never reuse one:
  // a collision would merge distinct identities in the rail and the shared-avatar handover.
  conversationSequence = Math.max(conversationSequence + 1, overrides.id ?? 0);
  return {
    id: conversationSequence,
    cwd: '/workspace/hearth',
    model: { provider: 'faux-hearth', modelId: 'glm-5.3-flash' },
    autoAccept: { enabled: false, allowed: [] },
    entries: [],
    nextEntry: 1,
    busy: false,
    compacting: false,
    approvals: [],
    questions: [],
    inbox: [],
    nextSubmission: 1,
    timers: [],
    ...overrides,
  };
};

const conversations: MockConversation[] = [];

// ---- Fixtures -----------------------------------------------------------------------

const fixtureA = makeConversation({
  id: 10,
  cwd: '/workspace/habit',
  title: 'Habit onboarding QA',
  entries: [
    { id: 1, kind: 'pi.user', model: [userMessage('QA the Habit onboarding flow.', minutes(40))] },
    {
      id: 2,
      kind: 'pi.assistant',
      model: [
        assistantMessage(
          [
            ...thinking('A checklist regression, most likely in the progress math.'),
            ...text('Found a regression: the step counter shows **3/2** on the last step.'),
          ],
          'stop',
          minutes(38)
        ),
      ],
    },
  ],
});

// A dedicated long-form study keeps the everyday short fixtures and their read-state scenarios intact.
if (fixtureParam === 'long-messages') {
  fixtureA.title = 'Long message layout study';
  fixtureA.entries = [
    { id: 1, kind: 'pi.user', model: [userMessage(longDemoPrompt, minutes(40))] },
    { id: 2, kind: 'pi.assistant', model: [assistantMessage(text(longDemoReview), 'stop', minutes(38))] },
    { id: 3, kind: 'pi.user', model: [userMessage('Walk through the same ideas from the perspective of someone returning after a day away. Keep the explanation detailed so we can compare two long replies.', minutes(37))] },
    { id: 4, kind: 'pi.assistant', model: [assistantMessage(text(longDemoFollowUp), 'stop', minutes(35))] },
  ];
}

const fixtureB = makeConversation({
  id: 11,
  cwd: '/workspace/channels',
  title: 'Remote access hardening',
  entries: [
    { id: 3, kind: 'pi.user', model: [userMessage('Review the Tailscale path and tighten auth.', minutes(90))] },
    {
      id: 4,
      kind: 'pi.assistant',
      model: [
        assistantMessage(
          [
            ...text('Reading the auth code now.'),
            ...toolCall('call_fixture_read', 'read', { path: 'src/remote.ts' }),
          ],
          'toolUse',
          minutes(88)
        ),
      ],
    },
    {
      id: 5,
      kind: 'pi.tool-result',
      model: [toolResult('call_fixture_read', 'read', 'export function startRemoteServer() { /* … */ }', false, minutes(88))],
    },
    {
      id: 6,
      kind: 'pi.assistant',
      model: [
        assistantMessage(
          [...text('The listener is correctly bound to Tailscale only. The dashboard is at http://localhost:5179 if you want to check from another machine.')],
          'stop',
          minutes(86)
        ),
      ],
    },
  ],
});

// Some stored tool steps are completed even though they are execution history, not replies.
if (fixtureParam === 'tool-unread') {
  fixtureB.entries[1].model![0].stopReason = 'stop';
  fixtureB.entries[3].id = 9;
  fixtureB.entries.splice(3, 0,
    { id: 7, kind: 'pi.assistant', model: [assistantMessage(
      toolCall('call_unread_check', 'bash', { command: 'bun test' }), 'stop', minutes(87)
    )] },
    { id: 8, kind: 'pi.tool-result', model: [toolResult('call_unread_check', 'bash', 'Tests passed', false, minutes(87))] }
  );
}

// An older host reuses an archived conversation when its schedule fires again.
if (fixtureParam === 'scheduled-archived') fixtureB.archived = minutes(100);

const fixtureC = makeConversation({
  id: 12,
  cwd: '/workspace/ember',
  title: 'Wire the pi mock',
  entries: [
    { id: 7, kind: 'pi.user', model: [userMessage('Wire the pi mock into dev:web.', minutes(12))] },
    {
      id: 8,
      kind: 'pi.assistant',
      model: [
        assistantMessage(
          [...text('About to delete the stale previews.'), ...toolCall('call_fixture_bash', 'bash', { command: 'vercel ls habit --meta stale=true' })],
          'toolUse',
          minutes(10)
        ),
      ],
    },
  ],
  approvals: [
    {
      key: 'fixture-approval',
      callId: 'call_fixture_bash',
      tool: 'bash',
      arguments: { command: 'vercel rm habit-preview-* --yes' },
      status: 'pending',
    },
  ],
});

const fixtureD = makeConversation({
  id: 13,
  cwd: '/workspace/research',
  title: 'Dataset shortlist',
  entries: [
    { id: 9, kind: 'pi.user', model: [userMessage('Shortlist research datasets.', minutes(300))] },
    {
      id: 10,
      kind: 'pi.assistant',
      model: [
        assistantMessage(
          toolCall('call_fixture_question', 'ask', {
            question: 'Which licence should the shortlist require? See https://example.com/licences',
            options: ['MIT', 'CC-BY', 'No preference'],
          }),
          'toolUse',
          minutes(299)
        ),
      ],
    },
  ],
  questions: [
    {
      key: 'fixture-question',
      question: 'Which licence should the shortlist require? See https://example.com/licences',
      options: ['MIT', 'CC-BY', 'No preference'],
      status: 'pending',
    },
  ],
  parked: { kind: 'question', callId: 'call_fixture_question' },
});

const fixtureE = makeConversation({
  id: 14,
  cwd: '/workspace/channels',
  title: 'Old thumbnail notes',
  archived: minutes(2_000),
  entries: [{ id: 10, kind: 'pi.assistant', model: [assistantMessage(text('Thumbnail notes from last week.'), 'stop', minutes(2_100))] }],
});

/** A 1×1 PNG, so a tool result can carry image content (the `view` tool / MCP screenshots). */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';

/** A user turn carrying an image attachment, as pi-ai content blocks. */
const userImage = (value: string, data: string): MockContent => [
  { type: 'text', text: value },
  { type: 'image', data, mimeType: 'image/png' },
];

const fixtureF = makeConversation({
  id: 15,
  cwd: '/workspace/research',
  title: 'Screenshot review',
  entries: [
    { id: 11, kind: 'pi.user', model: [userMessage('Show me the dashboard.', minutes(20))] },
    {
      id: 12,
      kind: 'pi.assistant',
      model: [
        assistantMessage(
          [...text('Here is the dashboard.'), ...toolCall('call_fixture_view', 'view', { path: 'dashboard.png' })],
          'toolUse',
          minutes(19)
        ),
      ],
    },
    {
      id: 13,
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'call_fixture_view',
          toolName: 'view',
          content: [{ type: 'image', data: TINY_PNG, mimeType: 'image/png' }],
          timestamp: minutes(19),
        },
      ],
    },
    // A second image in a *different* turn: the transcript viewer treats the conversation as one
    // gallery, so ←/→ and the on-screen buttons walk between turns.
    {
      id: 14,
      kind: 'pi.user',
      model: [
        userMessage(userImage('And this one from my phone.', TINY_PNG), minutes(18)),
      ],
    },
  ],
});

const fixtureG = makeConversation({
  id: 16,
  cwd: '/workspace/hearth',
  title: 'Crew: auth refactor',
  delegates: true,
  entries: [
    { id: 90, kind: 'pi.user', model: [userMessage('Refactor the auth module and split the work across the crew.', minutes(20))] },
    {
      id: 91,
      kind: 'pi.assistant',
      model: [
        assistantMessage(
          text('Spinning up two workers: one to parse the config, one to migrate the schema.'),
          'stop',
          minutes(19)
        ),
      ],
    },
    // The server-generated wake: a user input whose text starts with `[crew] `, rendered as a
    // "Crew report" system card rather than a user bubble.
    {
      id: 92,
      kind: new URLSearchParams(window.location.search).has('threads') ? 'hearth.thread-notice' : 'pi.user',
      model: [
        userMessage(
          '[crew] Crew report (generation 2): Parse config finished; Migrate schema needs a decision.',
          minutes(3)
        ),
      ],
    },
    {
      id: 93,
      kind: 'pi.assistant',
      model: [
        assistantMessage(
          text(new URLSearchParams(window.location.search).has('threads')
            ? '> Config parsing is complete.\n\nSource: [Parse config](/threads/17). Migrate schema needs your decision.'
            : 'Parse config is done. Migrate schema is blocked on a decision — open its chat to answer.'),
          'stop',
          minutes(3)
        ),
      ],
    },
  ],
});

// A busy worker: `busy` + a running tool, so its strip blob bounces and opening it shows the
// in-flight step. Ownerless with `kind: "worker"`, so the rail hides it by kind.
const fixtureH = makeConversation({
  id: 17,
  cwd: '/workspace/hearth',
  title: 'Parse config',
  kind: 'worker',
  // Workers are usually started with no reasoning at all: `off` is a level Hearth accepts but never
  // lists in a model's thinkingLevelMap, so this is the state that used to look "unavailable".
  thinkingLevel: 'off',
  lead: { conversationId: 16, host: 'local' },
  busy: true,
  entries: [
    { id: 94, kind: 'pi.user', model: [userMessage('Parse the config and report back.', minutes(6))] },
    {
      id: 95,
      kind: 'pi.assistant',
      model: [
        assistantMessage(
          [...text('Parsing the config now…'), ...toolCall('call_fixture_worker', 'bash', { command: 'bun run parse' })],
          'toolUse',
          minutes(5)
        ),
      ],
    },
  ],
  runningTool: { callId: 'call_fixture_worker', tool: 'bash' },
});

// A worker parked on a question: `needsInput` rolls up to the leader and shows the badge.
const fixtureI = makeConversation({
  id: 18,
  cwd: '/workspace/hearth',
  title: 'Migrate schema',
  kind: 'worker',
  lead: { conversationId: 16, host: 'local' },
  entries: [
    { id: 96, kind: 'pi.user', model: [userMessage('Migrate the schema.', minutes(4))] },
    {
      id: 97,
      kind: 'pi.assistant',
      model: [
        assistantMessage(
          toolCall('call_fixture_worker_ask', 'ask', { question: 'Drop the legacy column?', options: ['Yes', 'No'] }),
          'toolUse',
          minutes(4)
        ),
      ],
    },
  ],
  questions: [
    { key: 'worker-question', question: 'Drop the legacy column?', options: ['Yes', 'No'], status: 'pending' },
  ],
  parked: { kind: 'question', callId: 'call_fixture_worker_ask' },
});

conversations.push(fixtureA, fixtureB, fixtureC, fixtureD, fixtureE, fixtureF, fixtureG, fixtureH, fixtureI);

// A worker a human already promoted (`?promoted`): the strip row links to the peer fork and the
// peer shows in the rail, while the worker itself stays hidden.
const fixturePromotedWorker = makeConversation({
  id: 19,
  cwd: '/workspace/hearth',
  title: 'Harness audit',
  kind: 'worker',
  lead: { conversationId: 16, host: 'local' },
  promotedTo: 20,
  entries: [
    { id: 98, kind: 'pi.user', model: [userMessage('Audit the harness scripts.', minutes(30))] },
    {
      id: 99,
      kind: 'pi.assistant',
      model: [assistantMessage(text('Audit complete — two scripts need guards.'), 'stop', minutes(28))],
    },
  ],
});

const fixturePromotedPeer = makeConversation({
  id: 20,
  cwd: '/workspace/hearth',
  title: 'Harness improver',
  kind: 'peer',
  lead: { conversationId: 16, host: 'local' },
  delegates: true,
  entries: [
    { id: 200, kind: 'pi.user', model: [userMessage('Keep the harness improving.', minutes(28))] },
    {
      id: 201,
      kind: 'pi.assistant',
      model: [assistantMessage(text('I guard the scripts and tighten them over time.'), 'stop', minutes(27))],
    },
  ],
});

if (promotedFixture) conversations.push(fixturePromotedWorker, fixturePromotedPeer);

// The local agent name registry (`hearth.agents`): names are display-unique per host, so a second
// promotion of the same name is rejected. In memory for the mock's lifetime.
const agentNames = new Map<string, number>();

/**
 * Register a conversation the way Hearth does since 0.38.0: automatically, under its title, with a
 * numeric suffix when the title is taken, and reusing a row that already points at this conversation.
 * A spawned session therefore has a name the moment it exists — which is what the directory lists.
 */
const autoRegister = (conversation: MockConversation): string => {
  for (const [name, id] of agentNames) if (id === conversation.id) return name;
  const base = (conversation.title ?? '').trim() || `Bot ${conversation.id}`;
  let name = base;
  for (let attempt = 2; agentNames.has(name); attempt += 1) name = `${base} ${attempt}`;
  agentNames.set(name, conversation.id);
  return name;
};

/** Every fixture hands out its own id; a spawned conversation is created above the highest one. */
const FIXTURE_IDS = Math.max(0, ...conversations.map((conversation) => conversation.id));

// A host whose registry is not empty: Hearth registers every spawned session automatically, so a
// crew has names the moment it exists. Seeded here so `GET /directory` is never a lie in dev:web.
// A host registers every spawned session — but only the ones an agent created. The fixtures that
// stand for sessions a *human* started (and the promoted peer, which is registered by its promote)
// deliberately stay out of the registry, so `?promoted` still exercises the strip's peer link rather
// than promoting the peer a second time.
[fixtureH, fixtureI].forEach(autoRegister);

// ---- Events -------------------------------------------------------------------------

const eventListeners = new Set<(event: unknown) => void>();
type PiEventType =
  | 'run_start'
  | 'run_end'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'turn_end'
  | 'tool_execution_update'
  | 'submission'
  | 'usage_changed'
  | 'inbox_update'
  | 'compaction_start'
  | 'compaction_end';
const emit = (conversationId: number, type: PiEventType): void => {
  const hint = { instanceId: ENDPOINT_ID, type: `pi:${type}`, sessionId: String(conversationId) };
  eventListeners.forEach((listener) => listener(hint));
};

// ---- Run scripting ------------------------------------------------------------------

const schedule = (conversation: MockConversation, delay: number, run: () => void): void => {
  const timer = window.setTimeout(() => {
    conversation.timers = conversation.timers.filter((entry) => entry !== timer);
    run();
  }, delay);
  conversation.timers.push(timer);
};

const finishRun = (conversation: MockConversation): void => {
  conversation.busy = false;
  conversation.parked = undefined;
  // A settled turn is no longer in flight; Hearth drops the slot when the entry lands.
  conversation.liveGeneration = undefined;
  emit(conversation.id, 'run_end');
  emit(conversation.id, 'usage_changed');
  const next = conversation.inbox.shift();
  if (next) {
    emit(conversation.id, 'inbox_update');
    emit(conversation.id, 'submission');
    startRun(conversation, next.content);
  }
};

const parkApproval = (conversation: MockConversation, tool: string, args: Record<string, unknown>, after: () => void): void => {
  const callId = nextCallId();
  conversation.entries.push({
    id: nextEntryId(),
    kind: 'pi.assistant',
    model: [assistantMessage(toolCall(callId, tool, args), 'toolUse')],
  });
  emit(conversation.id, 'message_end');
  if (conversation.autoAccept.enabled || conversation.autoAccept.allowed.includes(tool)) {
    schedule(conversation, 200, () => {
      acceptApproval(conversation, callId, after);
    });
    return;
  }
  const key = String(nextEntryId());
  conversation.approvals.push({ key, callId, tool, arguments: args, status: 'pending' });
  conversation.parked = { kind: 'approval', callId, followUp: after };
  emit(conversation.id, 'turn_end');
};

const acceptApproval = (conversation: MockConversation, callId: string, after: () => void): void => {
  const approval = conversation.approvals.find((entry) => entry.callId === callId);
  const tool = approval?.tool ?? 'tool';
  const command = typeof approval?.arguments.command === 'string' ? approval.arguments.command : undefined;
  conversation.entries.push({
    id: nextEntryId(),
    kind: 'pi.tool-result',
    model: [toolResult(callId, tool, tool === 'bash' && command ? `${command}\n` : 'ok')],
  });
  emit(conversation.id, 'tool_execution_update');
  emit(conversation.id, 'message_end');
  schedule(conversation, 350, () => {
    conversation.entries.push({
      id: nextEntryId(),
      kind: 'pi.assistant',
      model: [assistantMessage(text('Done. The tool ran and I carried on.'))],
    });
    emit(conversation.id, 'message_end');
    emit(conversation.id, 'turn_end');
    after();
  });
};

const replyApprovalMock = (conversation: MockConversation, key: string, decision: 'once' | 'always' | 'reject'): boolean => {
  const approval = conversation.approvals.find((entry) => entry.key === key);
  if (!approval || approval.status !== 'pending') return false;
  approval.status = decision;
  if (decision === 'always') {
    conversation.autoAccept.enabled = true;
  }
  const followUp = conversation.parked?.followUp ?? (() => finishRun(conversation));
  conversation.parked = undefined;
  if (decision === 'reject') {
    conversation.entries.push({
      id: nextEntryId(),
      kind: 'pi.tool-result',
      model: [toolResult(approval.callId, approval.tool, 'The user rejected this tool call.', true)],
    });
    emit(conversation.id, 'tool_execution_update');
    schedule(conversation, 200, () => {
      conversation.entries.push({
        id: nextEntryId(),
        kind: 'pi.assistant',
        model: [assistantMessage(text('Understood — I will not run that.'))],
      });
      emit(conversation.id, 'message_end');
      emit(conversation.id, 'turn_end');
      finishRun(conversation);
    });
    return true;
  }
  acceptApproval(conversation, approval.callId, followUp);
  return true;
};

const parkQuestion = (conversation: MockConversation, question: string, options: string[]): void => {
  const callId = nextCallId();
  conversation.entries.push({
    id: nextEntryId(),
    kind: 'pi.assistant',
    model: [assistantMessage(toolCall(callId, 'ask', { question, options }), 'toolUse')],
  });
  emit(conversation.id, 'message_end');
  const key = String(nextEntryId());
  conversation.questions.push({ key, question, options, status: 'pending' });
  conversation.parked = {
    kind: 'question',
    callId,
    followUp: () => finishRun(conversation),
  };
  emit(conversation.id, 'turn_end');
};

const replyQuestionMock = (conversation: MockConversation, key: string, answer: string | null): boolean => {
  const question = conversation.questions.find((entry) => entry.key === key);
  if (!question || question.status !== 'pending') return false;
  question.status = answer === null ? 'cancelled' : 'answered';
  if (answer !== null) question.answer = answer;
  const callId = conversation.parked?.callId ?? 'call_unknown';
  conversation.entries.push({
    id: nextEntryId(),
    kind: 'pi.tool-result',
    model: [
      toolResult(callId, 'ask', answer === null ? 'The user dismissed this question.' : `The user answered: ${answer}`, answer === null),
    ],
  });
  emit(conversation.id, 'tool_execution_update');
  const followUp = conversation.parked?.followUp;
  conversation.parked = undefined;
  schedule(conversation, 250, () => {
    conversation.entries.push({
      id: nextEntryId(),
      kind: 'pi.assistant',
      model: [assistantMessage(text(answer === null ? 'No problem — moving on.' : `Got it: ${answer}.`))],
    });
    emit(conversation.id, 'message_end');
    emit(conversation.id, 'turn_end');
    (followUp ?? (() => finishRun(conversation)))();
  });
  return true;
};

/** One scripted faux turn chosen from the prompt's text. */
const startRun = (conversation: MockConversation, content: MockContent): number => {
  const submissionId = nextSubmissionId();
  conversation.busy = true;
  // A session spawned by the crew tool gets its name at spawn, the way Hearth does it since 0.38.0.
  // The first message a spawner sends is its brief, which is where the title comes from (a spawned
  // conversation is created without one), so registration happens here rather than at creation.
  // Only a conversation that is still being *born* takes its title from the brief: the crew tool
  // creates it titleless and posts the brief right after. Giving a title to one the human already
  // named was wrong — taking a question on a worker renamed it after the question.
  if (conversation.kind && conversation.id > FIXTURE_IDS && !conversation.title) {
    const brief = textOf(content).replace(/\s+/g, ' ').trim();
    conversation.title = brief.length > 48 ? `${brief.slice(0, 45).trimEnd()}…` : brief || undefined;
    autoRegister(conversation);
  }
  conversation.entries.push({ id: nextEntryId(), kind: 'pi.user', model: [userMessage(content)] });
  emit(conversation.id, 'run_start');
  emit(conversation.id, 'message_start');
  emit(conversation.id, 'submission');

  const lower = textOf(content).toLowerCase();
  const slow = lower.includes('slow');
  // A long "slow" window so the busy state survives a state/session poll in tests.
  const delay = slow ? 12_000 : 550;

  if (lower.includes('bash') || lower.includes('run `') || lower.includes('delete')) {
    schedule(conversation, 300, () =>
      parkApproval(conversation, 'bash', { command: 'echo hearth-mock' }, () => finishRun(conversation))
    );
    return submissionId;
  }
  if (lower.includes('interrupt')) {
    // A long tool step stays running until the user stops the run; the abort turns it into an
    // interrupted tool-result, which the transcript renders as `[step interrupted]`.
    const callId = nextCallId();
    conversation.entries.push({
      id: nextEntryId(),
      kind: 'pi.assistant',
      model: [assistantMessage(toolCall(callId, 'bash', { command: 'sleep 100' }), 'toolUse')],
    });
    emit(conversation.id, 'message_end');
    conversation.runningTool = { callId, tool: 'bash' };
    emit(conversation.id, 'tool_execution_update');
    return submissionId;
  }
  if (lower.includes('live tail')) {
    // A command whose output arrives while it runs, the shape Hearth's bash tool produces:
    // `api.output()` → the `pi.live` slot → a `tool_execution_update` hint per flush. The row must
    // show those lines as they land, and then be replaced by the settled result.
    const callId = nextCallId();
    conversation.entries.push({
      id: nextEntryId(),
      kind: 'pi.assistant',
      model: [assistantMessage(toolCall(callId, 'bash', { command: 'grep -c "^RC=" stage2.log' }), 'toolUse')],
    });
    emit(conversation.id, 'message_end');
    conversation.runningTool = { callId, tool: 'bash', output: '' };
    emit(conversation.id, 'tool_execution_update');
    const chunks = ['waiting for RC= in stage2.log\n', 'RC=0\n', 'FINAL-CUT-v2.iso\n'];
    chunks.forEach((chunk, index) => {
      schedule(conversation, 500 * (index + 1), () => {
        if (!conversation.runningTool) return;
        conversation.runningTool = {
          ...conversation.runningTool,
          output: (conversation.runningTool.output ?? '') + chunk,
        };
        emit(conversation.id, 'tool_execution_update');
      });
    });
    // A comfortable gap after the last chunk: a command's output streams for a while and then
    // settles, and a test watching the live tail needs to see the last line before it is replaced.
    schedule(conversation, 500 * chunks.length + 1_500, () => {
      const output = conversation.runningTool?.output ?? '';
      conversation.runningTool = undefined;
      conversation.entries.push({
        id: nextEntryId(),
        kind: 'pi.tool-result',
        model: [toolResult(callId, 'bash', output)],
      });
      emit(conversation.id, 'message_end');
      finishRun(conversation);
    });
    return submissionId;
  }
  if (lower.includes('failing grep')) {
    // The shape a `grep`-style command fails in: a long retained log, exit 1, and the line worth
    // reading past the old 400-character cut. The row must show the whole thing and name the code.
    const callId = nextCallId();
    const output = [
      ...Array.from({ length: 12 }, (_, i) => `waiting for RC= … attempt ${i + 1}`),
      'RC=[missing]',
      'FINAL-CUT-v2.iso   1.8 MB',
    ].join('\n');
    conversation.entries.push({
      id: nextEntryId(),
      kind: 'pi.assistant',
      model: [assistantMessage(toolCall(callId, 'bash', { command: 'grep "^RC=" stage2.log' }), 'toolUse')],
    });
    schedule(conversation, 300, () => {
      conversation.entries.push({
        id: nextEntryId(),
        kind: 'pi.tool-result',
        model: [
          {
            ...toolResult(callId, 'bash', output, true),
            details: {
              exitCode: 1,
              truncated: true,
              diagnostics: [{ severity: 'error', code: 'exit_code', message: 'Command exited with code 1' }],
            },
          },
        ],
      });
      emit(conversation.id, 'message_end');
      finishRun(conversation);
    });
    return submissionId;
  }
  if (lower.includes('ask') || lower.includes('which')) {
    schedule(conversation, 300, () =>
      parkQuestion(conversation, 'Which option should I take?', ['Option A', 'Option B'])
    );
    return submissionId;
  }

  const reply =
    lower.includes('hello') || lower.includes('hi')
      ? 'Hello! ember-harness is listening.'
      : `Echo from Hearth: ${content}`;
  // Stream the generation the way Hearth does: into `pi.live.generation.message`, not into an
  // entry. A `docs=1` tail read sees the reasoning grow mid-turn; only the end of the turn turns it
  // into a durable `pi.assistant` entry. Tests that assert live reasoning rely on this split.
  const provider = conversation.model.provider;
  const model = conversation.model.modelId;
  conversation.liveGeneration = {
    provider,
    model,
    thinking: `The user said: ${content}`,
    text: '',
  };
  schedule(conversation, delay * 0.4, () => {
    if (conversation.liveGeneration) conversation.liveGeneration.thinking += ' (still thinking…)';
    emit(conversation.id, 'message_update');
  });
  schedule(conversation, delay * 0.7, () => {
    if (conversation.liveGeneration) conversation.liveGeneration.text = reply;
    emit(conversation.id, 'message_update');
  });
  schedule(conversation, delay, () => {
    const live = conversation.liveGeneration;
    conversation.liveGeneration = undefined;
    conversation.entries.push({
      id: nextEntryId(),
      kind: 'pi.assistant',
      model: [assistantMessage([...thinking(live?.thinking ?? 'Composing a short reply.'), ...text(reply)])],
    });
    emit(conversation.id, 'message_end');
    emit(conversation.id, 'turn_end');
    finishRun(conversation);
  });
  return submissionId;
};


// ---- Wire -----------------------------------------------------------------------------

/**
 * What Hearth's usage ledger would total for this conversation: the sum of its turns' reported
 * cost, `0` for one that has never run.
 */
const ledgerCostOf = (conversation: MockConversation): number => {
  if (unpricedCostFixture) return 0;
  return conversation.entries.reduce((total, entry) => {
    const cost = (entry.model?.[0]?.usage as { cost?: { total?: number } } | undefined)?.cost?.total;
    return total + (typeof cost === 'number' ? cost : 0);
  }, 0);
};

const summaryOf = (conversation: MockConversation): Record<string, unknown> => ({
  id: conversation.id,
  cwd: conversation.cwd,
  model: conversation.model,
  thinkingLevel: conversation.thinkingLevel,
  ...(conversation.title ? { title: conversation.title } : {}),
  ...(conversation.archived ? { archived: conversation.archived } : {}),
  ...(conversation.kind ? { kind: conversation.kind } : {}),
  ...(conversation.lead ? { lead: conversation.lead } : {}),
  ...(conversation.promotedTo !== undefined ? { promotedTo: conversation.promotedTo } : {}),
  ...(conversation.delegates ? { delegates: conversation.delegates } : {}),
  // Hearth computes this from the pending approval + question docs; mirror it so the crew strip
  // needs no per-worker reads.
  needsInput:
    conversation.approvals.some((entry) => entry.status === 'pending') ||
    conversation.questions.some((entry) => entry.status === 'pending'),
  // Hearth reports the newest entry's ordinal, and Ember's read marks use that same number: a
  // summary whose `lastEntryId` disagreed with the entries would make every transcript look read
  // (or permanently unread). Entries are the source, in both places.
  lastEntryId: conversation.entries.length ? Math.max(...conversation.entries.map((entry) => entry.id)) : undefined,
  updatedAt: Math.max(
    ...conversation.entries.map((entry) => Number((entry.model?.[0]?.timestamp as number) ?? 0)),
    0
  ),
  busy: conversation.busy,
  autoAccept: conversation.autoAccept.enabled,
  compacting: conversation.compacting,
  // Hearth sends `cost` on every summary; the mock has to as well, or the badge's "never ran" and
  // "unknown" states are indistinguishable in dev:web.
  cost: ledgerCostOf(conversation),
  ...(fixtureParam === 'processes' && conversation.id === 10 ? { processes: {
    count: 2, rssBytes: 32 * 1024 * 1024, items: [
      { pid: 91001, command: 'vite --host 127.0.0.1', rssBytes: 20 * 1024 * 1024, startedAt: Date.now() },
      { pid: 91002, command: 'bun run api', rssBytes: 12 * 1024 * 1024, startedAt: Date.now() },
    ],
  } } : {}),
});

const docsOf = (conversation: MockConversation): Record<string, unknown> => {
  const live = conversation.liveGeneration;
  return {
    'pi.agent': { model: conversation.model, thinkingLevel: conversation.thinkingLevel, cwd: conversation.cwd },
    'pi.live':
      conversation.runningTool || conversation.parked || conversation.busy || live
        ? {
            run: { taskId: 1, inputs: [1] },
            ...(conversation.runningTool
              ? {
                  tools: [
                    {
                      callId: conversation.runningTool.callId,
                      name: conversation.runningTool.tool,
                      status: 'running',
                      ...(conversation.runningTool.output === undefined
                        ? {}
                        : { output: conversation.runningTool.output }),
                    },
                  ],
                }
              : {}),
            // `generation.message` is the streaming assistant message; the mapper reads its content
            // blocks, so a thinking block mid-turn is exactly what the transcript should show.
            ...(live
              ? {
                  generation: {
                    message: {
                      role: 'assistant',
                      provider: live.provider,
                      model: live.model,
                      content: [
                        ...(live.thinking ? [{ type: 'thinking', thinking: live.thinking }] : []),
                        ...(live.text ? [{ type: 'text', text: live.text }] : []),
                      ],
                      timestamp: 0,
                    },
                  },
                }
              : {}),
          }
        : {},
    'pi.inbox': { items: conversation.inbox },
    'hearth.auto-accept': conversation.autoAccept,
    'hearth.approvals': {
      items: Object.fromEntries(conversation.approvals.map((entry) => [entry.key, { ...entry, conversationId: String(conversation.id) }])),
    },
    'hearth.questions': {
      items: Object.fromEntries(conversation.questions.map((entry) => [entry.key, { ...entry, conversationId: String(conversation.id) }])),
    },
  };
};

const snapshotOf = (conversation: MockConversation): Record<string, unknown> => ({
  conversation: summaryOf(conversation),
  entries: conversation.entries,
  docs: docsOf(conversation),
});

/**
 * The entry id a `cursor` names, or `undefined` when it names none.
 *
 * The cursor is opaque to the client — it echoes back exactly what the host handed it — so the mock
 * defines its own: `{ before: id }`, "the page older than this entry". A cursor the mock cannot read
 * (absent, malformed, or one it never issued) means "start from the newest entry"; it must never be
 * read as "there is nothing older", which would silently truncate a transcript.
 */
const cursorBeforeOf = (raw: string | null): number | undefined => {
  if (!raw) return undefined;
  try {
    const before = (JSON.parse(raw) as { before?: unknown } | null)?.before;
    return typeof before === 'number' && Number.isFinite(before) ? before : undefined;
  } catch {
    return undefined;
  }
};

const conversationById = (raw: string): MockConversation | undefined =>
  conversations.find((conversation) => String(conversation.id) === raw);

const piRequest = async (
  endpointId: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<{ ok: boolean; status: number; data: unknown }> => {
  const method = (init.method ?? 'GET').toUpperCase();
  const body = (init.body ?? {}) as Record<string, unknown>;
  const ok = (data: unknown, status = 200) => ({ ok: true, status, data });
  const fail = (status: number, error: string) => ({ ok: false, status, data: { error } });
  const url = new URL(path, 'http://mock');

  // The `?outage` endpoint is down: every request to it fails at the transport, the way a real
  // unreachable host does. Without this the mock answered for it and made an outage look healthy.
  if (outageFixture && endpointId === OUTAGE_ENDPOINT.id) {
    return fail(0, 'Ember → Studio Mac: the host is not answering');
  }
  if (url.pathname === '/health' && method === 'GET') return ok({ ok: true, service: 'hearth', version: 'mock' });
  if (url.pathname === '/models' && method === 'GET') {
    return ok({ models, default: { provider: 'faux-hearth', modelId: 'glm-5.3-flash' } });
  }
  if (url.pathname === '/providers' && method === 'GET') {
    return ok({
      providers: providers.map((provider) => ({
        ...provider,
        credential: providerCredentials.get(provider.id) ?? null,
        ...(provider.signIn
          ? { signIn: { ...provider.signIn, pending: mockLogins.has(provider.id) } }
          : {}),
      })),
      default: { provider: 'faux-hearth', modelId: 'glm-5.3-flash' },
    });
  }
  // OAuth sign-in, mirroring Hearth: start hands back a device code, poll reports progress,
  // delete cancels. In-memory only, so a reload forgets a flow exactly like a real abandoned one.
  const loginMatch = /^\/providers\/([^/]+)\/login$/.exec(url.pathname);
  if (loginMatch) {
    const providerId = decodeURIComponent(loginMatch[1]);
    if (!providers.some((provider) => provider.id === providerId)) return fail(404, 'unknown provider');
    if (method === 'DELETE') {
      mockLogins.delete(providerId);
      return ok({ ok: true, cancelled: true });
    }
    if (method === 'POST') {
      mockLogins.set(providerId, { polls: 0 });
      return ok({
        status: 'pending',
        events: [
          {
            type: 'device_code',
            userCode: 'MOCK-1234',
            verificationUri: 'https://accounts.x.ai/oauth2/device?user_code=MOCK-1234',
            intervalSeconds: 5,
            expiresInSeconds: 1800,
          },
        ],
      });
    }
    // GET: pending for a couple of polls, then complete — enough to exercise the dialog without a
    // browser, and deterministic so tests aren't flaky.
    const flow = mockLogins.get(providerId);
    if (!flow) return fail(404, 'no login in progress');
    flow.polls += 1;
    if (flow.polls < 2) {
      return ok({
        status: 'pending',
        events: [
          {
            type: 'device_code',
            userCode: 'MOCK-1234',
            verificationUri: 'https://accounts.x.ai/oauth2/device?user_code=MOCK-1234',
          },
        ],
      });
    }
    mockLogins.delete(providerId);
    providerCredentials.set(providerId, 'oauth');
    return ok({
      status: 'complete',
      events: [],
      credential: { type: 'oauth', access: 'mock', refresh: 'mock', expires: Date.now() + 3_600_000 },
    });
  }
  const providerMatch = /^\/providers\/(.+)$/.exec(url.pathname);
  if (providerMatch && (method === 'POST' || method === 'DELETE')) {
    const providerId = decodeURIComponent(providerMatch[1]);
    if (!providers.some((provider) => provider.id === providerId)) return fail(404, 'unknown provider');
    if (method === 'DELETE') {
      providerCredentials.delete(providerId);
      return ok({ ok: true, provider: providerId, credential: null });
    }
    if (body.type !== 'api_key' || typeof body.key !== 'string' || !body.key) {
      return fail(400, 'expected a credential, e.g. { "type": "api_key", "key": "…" }');
    }
    providerCredentials.set(providerId, 'api_key');
    return ok({ ok: true, provider: providerId, credential: 'api_key' });
  }
  if (url.pathname === '/usage' && method === 'GET') {
    return ok({ models: { 'faux-hearth/glm-5.3-flash': { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } }, tools: {} });
  }
  if (url.pathname === '/queue' && method === 'GET') {
    return ok({
      revision: Date.now(),
      sessions: conversations
        .filter((conversation) => conversation.inbox.length > 0)
        .map((conversation) => ({
          sessionId: String(conversation.id),
          directory: conversation.cwd,
          model: conversation.model,
          thinkingLevel: conversation.thinkingLevel,
          sendingId: null,
          items: conversation.inbox.map((item) => ({
            id: String(item.id),
            mode: item.mode,
            text: textOf(item.content),
            // Real Hearth returns the content parts alongside the preview, so a queued image keeps
            // its payload for the row and for "send now".
            content: item.content,
          })),
        })),
    });
  }
  if (url.pathname === '/directories' && method === 'POST') {
    const parent = String(body.parent); const name = String(body.name);
    const path = `${parent === '/' ? '' : parent}/${name}`;
    if (!mockFolders[parent] || mockFolders[path] || !name || /[\\/]/.test(name)) return fail(400, 'Choose another folder name.');
    mockFolders[parent].push(name); mockFolders[path] = [];
    return ok({ path }, 201);
  }
  if (url.pathname === '/directories' && method === 'GET') {
    const path = url.searchParams.get('path') || '/workspace';
    if (!(path in mockFolders)) return { ok: false, status: 400, data: { error: 'not a directory' } };
    return ok({ workspace: '/workspace', path, directories: mockFolders[path].map((name) => ({
      name, path: `${path === '/' ? '' : path}/${name}`, hasChildren: true,
    })) });
  }
  if (url.pathname === '/scheduled-tasks' && method === 'GET') {
    return ok({
      timezone: 'UTC',
      tasks: [
        {
          id: 'task_1',
          name: 'Nightly brief',
          prompt: 'Write the brief',
          enabled: true,
          schedule: { kind: 'daily', time: '09:00' },
          createdAt: Date.now() - 86_400_000,
          lastRunAt: Date.now() - 3_600_000,
          lastStatus: 'ok',
          lastSessionId: 11,
        },
      ],
    });
  }
  const scheduledRun = /^\/scheduled-tasks\/([^/]+)\/run$/.exec(url.pathname);
  if (scheduledRun && method === 'POST') return ok({ status: 'ok', sessionId: 11 });
  const scheduledPatch = /^\/scheduled-tasks\/([^/]+)$/.exec(url.pathname);
  if (scheduledPatch && method === 'PATCH') return ok({ ok: true });
  if (url.pathname === '/approvals' && method === 'GET') {
    return ok({
      approvals: conversations.flatMap((conversation) =>
        conversation.approvals
          .filter((approval) => approval.status === 'pending')
          .map((approval) => ({ ...approval, conversationId: String(conversation.id) }))
      ),
    });
  }
  const approvalReply = /^\/approvals\/([^/]+)\/([^/]+)\/reply$/.exec(url.pathname);
  if (approvalReply && method === 'POST') {
    const conversation = conversationById(decodeURIComponent(approvalReply[1]));
    if (!conversation) return fail(404, 'no such conversation');
    const decision = body.decision;
    if (decision !== 'once' && decision !== 'always' && decision !== 'reject') return fail(400, 'bad decision');
    return replyApprovalMock(conversation, decodeURIComponent(approvalReply[2]), decision)
      ? ok({ ok: true })
      : fail(404, 'no such approval');
  }
  if (url.pathname === '/questions' && method === 'GET') {
    return ok({
      questions: conversations.flatMap((conversation) =>
        conversation.questions
          .filter((question) => question.status === 'pending')
          .map((question) => ({ ...question, conversationId: String(conversation.id) }))
      ),
    });
  }
  const questionReply = /^\/questions\/([^/]+)\/([^/]+)\/reply$/.exec(url.pathname);
  if (questionReply && method === 'POST') {
    const conversation = conversationById(decodeURIComponent(questionReply[1]));
    if (!conversation) return fail(404, 'no such conversation');
    const answer = body.answer;
    if (answer !== null && typeof answer !== 'string') return fail(400, 'answer must be a string or null');
    return replyQuestionMock(conversation, decodeURIComponent(questionReply[2]), answer)
      ? ok({ ok: true })
      : fail(404, 'no such question');
  }
  // The agent directory (`GET /directory`): the registry merged with live status, the way Hearth
  // serves it. One pinned peer, one busy, one waiting — enough for the view and its e2e.
  if (url.pathname === '/directory' && method === 'GET') {
    // The registry as it actually stands, plus the fixtures a host would have registered when they
    // were spawned — the same map the promote route writes into, so a promotion shows up here.
    const pinned = new Map([
      [11, { name: 'Archivist', pinned: true }],
      [15, { name: 'Reviewer', pinned: false }],
      [13, { name: 'Cartographer', pinned: false }],
    ]);
    const agents = [...pinned.entries()].flatMap(([id, seed]) => {
      const conversation = conversationById(String(id));
      if (!conversation) return [];
      const summary = summaryOf(conversation);
      return [{ ...seed, ...summary, host: 'local', kind: conversation.kind ?? 'peer' }];
    });
    const registered = [...agentNames.entries()].flatMap(([name, id]) => {
      if (pinned.has(id)) return [];
      const conversation = conversationById(String(id));
      if (!conversation) return [];
      const summary = summaryOf(conversation);
      return [
        {
          name,
          ...summary,
          host: 'local',
          pinned: false,
          kind: conversation.kind,
          createdAt: Date.now() - 600_000,
        },
      ];
    });
    return ok({ agents: [...agents, ...registered] });
  }
  if (url.pathname === '/conversations' && method === 'GET') {
    return ok({ conversations: conversations.map(summaryOf) });
  }
  if (url.pathname === '/conversations' && method === 'POST') {
    if (slowCreateFixture) await waitForCreateRelease();
    const cwd = typeof body.cwd === 'string' ? body.cwd : '/workspace/hearth';
    if (failCreateFixture && createAttempts++ === 0) return fail(400, `folder does not exist: ${cwd}`);
    const model = (body.model as { provider?: string; modelId?: string } | undefined) ?? undefined;
    const conversation = makeConversation({
      // Above every fixture id. The sequence counted *calls* to makeConversation, while fixtures
      // hand out their own ids, so a created conversation could land on an existing one and every
      // read would find the fixture instead — a "new agent" that opened someone else's chat.
      id: Math.max(9, ...conversations.map((entry) => entry.id)) + 1,
      cwd,
      title: typeof body.title === 'string' ? body.title : undefined,
      ...(model?.provider && model?.modelId ? { model: { provider: model.provider, modelId: model.modelId } } : {}),
    });
    conversations.push(conversation);
    autoRegister(conversation);
    if (dropCreateFixture) {
      // The conversation is real; the client simply never heard so. Retrying must not create a
      // second one, which is why the retry re-asks for the same request id.
      return {
        ok: false,
        status: 0,
        data: {
          error: 'Ember lost its connection to ember-harness (mock) partway through. Nothing was answered — try that again.',
        },
      };
    }
    return ok(summaryOf(conversation), 201);
  }

  const conversationMatch = /^\/conversations\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!conversationMatch) return fail(404, 'not found');
  const conversation = conversationById(decodeURIComponent(conversationMatch[1]));
  if (!conversation) return fail(404, 'no such conversation');
  const action = conversationMatch[2] ?? '';

  if (!action && method === 'GET') return ok(snapshotOf(conversation));
  if (action === 'entries' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
    // Both filters the client sends are honoured here. `since` asks for the entries *newer* than an
    // id (the incremental append read); `cursor` asks for the page *older* than the one already
    // held (the full-history walk). The route serves newest-first, `limit`-bounded, either way.
    //
    // Honouring the cursor is what makes this mock usable: it used to ignore it and always answer
    // with `next: null`, so every walk was handed the same first page for ever and the transcript
    // rendered one conversation's entries hundreds of times.
    const rawSince = url.searchParams.get('since');
    const since = rawSince === null ? undefined : Number(rawSince);
    const before = cursorBeforeOf(url.searchParams.get('cursor'));
    let pool = conversation.entries;
    if (since !== undefined && Number.isFinite(since)) pool = pool.filter((entry) => entry.id > since);
    if (before !== undefined) pool = pool.filter((entry) => entry.id < before);
    const page = pool.slice(-limit).reverse();
    const body: Record<string, unknown> = { entries: page };
    // `next` appears only when older entries actually remain: a host that always sets it leaves the
    // client paging to its cap, and one that sets it without more to give makes the client's own
    // "no new entries" guard the only thing standing between it and a duplicated transcript.
    const oldest = page[page.length - 1];
    if (oldest !== undefined && pool.length > page.length) body.next = { before: oldest.id };
    // Hearth returns the conversation's documents alongside the page, and the client asks for them
    // with `docs=1` precisely so a tail read can see `pi.live` — the reasoning and text being
    // written right now. Omitting them here made the mock disagree with Hearth's contract, so every
    // tail in dev and in the pi e2e suite looked like an older Hearth with no in-flight generation.
    if (url.searchParams.get('docs') === '1') body.docs = docsOf(conversation);
    return ok(body);
  }
  if (!action && method === 'PATCH') {
    if (body.title !== undefined && body.title !== null) conversation.title = String(body.title);
    if (body.archived !== undefined) {
      if (body.archived === null) delete conversation.archived;
      else conversation.archived = Number(body.archived);
    }
    emit(conversation.id, 'run_end');
    return ok(summaryOf(conversation));
  }
  if (action === 'submit' && method === 'POST') {
    if (failSubmitFixture) return fail(502, 'Hearth is unreachable (mock)');
    if (slowSubmitFixture) await new Promise((resolve) => window.setTimeout(resolve, SLOW_SUBMIT_MS));
    if (body.type === 'write') {
      const entry = (body.entry as { kind?: string; data?: unknown }) ?? {};
      conversation.entries.push({
        id: nextEntryId(),
        kind: typeof entry.kind === 'string' ? entry.kind : 'pi.write',
      });
      return ok({ submissionId: nextSubmissionId(), status: 'placed', mode: 'write' }, 201);
    }
    const raw = body.content;
    if (typeof raw === 'string' ? !raw.trim() : !Array.isArray(raw) || raw.length === 0) {
      return fail(400, 'content is required');
    }
    if (Array.isArray(raw)) {
      // Mirror Hearth's gate: only the parts a human turn can carry.
      const bad = raw.find(
        (part) =>
          !part ||
          typeof part !== 'object' ||
          ((part as { type?: unknown }).type !== 'text' && (part as { type?: unknown }).type !== 'image')
      );
      if (bad) return fail(400, `unsupported content part: ${String((bad as { type?: unknown }).type)}`);
    }
    const content = raw as MockContent;
    const whenBusy = body.whenBusy;
    if ((conversation.busy || (staleBusyFixture && whenBusy === 'followUp')) && whenBusy === 'followUp') {
      conversation.inbox.push({ id: nextSubmissionId(), mode: 'followUp', content });
      emit(conversation.id, 'submission');
      emit(conversation.id, 'inbox_update');
      // Hearth admits a queued submission with `status: "queued"` and names the queue in `mode`,
      // so the client can tell a steer from a follow-up; mirror that exactly.
      return ok({ submissionId: conversation.inbox[conversation.inbox.length - 1].id, status: 'queued', mode: 'followUp' }, 201);
    }
    if (conversation.busy && whenBusy === 'steer') {
      // pi-durable tags a steer in the inbox and places it at the next boundary — it is not a
      // parked follow-up. Keep it in the inbox so `/queue` reports it like real Hearth does (and a
      // client that forgets to filter steers shows the bug).
      conversation.inbox.push({ id: nextSubmissionId(), mode: 'steer', content });
      emit(conversation.id, 'submission');
      emit(conversation.id, 'inbox_update');
      return ok({ submissionId: conversation.inbox[conversation.inbox.length - 1].id, status: 'queued', mode: 'steer' }, 201);
    }
    if (conversation.busy) {
      conversation.inbox.push({ id: nextSubmissionId(), mode: 'followUp', content });
      emit(conversation.id, 'inbox_update');
      return ok({ submissionId: conversation.inbox[conversation.inbox.length - 1].id, status: 'queued', mode: 'followUp' }, 201);
    }
    return ok({ submissionId: startRun(conversation, content), status: 'placed', mode: whenBusy === 'steer' ? 'steer' : 'followUp' }, 201);
  }
  if (action === 'abort' && method === 'POST') {
    conversation.timers.forEach((timer) => window.clearTimeout(timer));
    conversation.timers = [];
    conversation.busy = false;
    conversation.parked = undefined;
    // Hearth does not throw the queue away: it withdraws every queued input and re-parks it in the
    // same mode, then reports what it kept (`parking.ts`). Re-parking means fresh ids, which is what
    // makes a client holding the old rows' ids look broken until it re-reads the queue.
    const kept = conversation.inbox.map((item) => ({ ...item, id: nextSubmissionId() }));
    conversation.inbox = kept;
    emit(conversation.id, 'inbox_update');
    // A stop cuts a running step short: Hearth commits an aborted tool-result, and the
    // transcript renders it as `[step interrupted]` rather than a red error.
    if (conversation.runningTool) {
      const { callId, tool } = conversation.runningTool;
      conversation.runningTool = undefined;
      conversation.entries.push({
        id: nextEntryId(),
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolCallId: callId,
            toolName: tool,
            content: [{ type: 'text', text: `<harness>\n[error] Tool ${tool} was aborted\n</harness>` }],
            isError: true,
            timestamp: Date.now(),
          },
        ],
      });
      emit(conversation.id, 'message_end');
    }
    emit(conversation.id, 'run_end');
    return ok({
      ok: true,
      ...(kept.length > 0
        ? { parked: kept.length, parkedText: kept.map((item) => textOf(item.content).slice(0, 80)) }
        : {}),
    });
  }
  if (action === 'compact' && method === 'POST') {
    // `?compactNoop` is what Hearth does when the transcript already fits the kept window: it answers
    // 202 with a task id and then posts no summary, no flag and no event. The client has to notice
    // the silence and say so (`npm run dev:web` → "Nothing to compact").
    if (compactNoopFixture) return ok({ taskId: nextEntryId() }, 202);
    // A manual compaction runs as a task and places its summary at the next boundary; while it is
    // in flight the conversation summary reports `compacting` (mirrors Hearth's pi.live.compactions).
    conversation.compacting = true;
    emit(conversation.id, 'compaction_start');
    conversation.entries.push({ id: nextEntryId(), kind: 'pi.compaction' });
    schedule(conversation, 1_500, () => {
      conversation.compacting = false;
      emit(conversation.id, 'compaction_end');
    });
    return ok({ taskId: nextEntryId() }, 202);
  }
  if (action === 'queue/order' && method === 'PUT') {
    const ids = Array.isArray(body.itemIds) ? body.itemIds.map((value) => String(value)) : [];
    const byId = new Map(conversation.inbox.map((item) => [String(item.id), item]));
    if (ids.length !== conversation.inbox.length || ids.some((id) => !byId.has(id))) {
      return fail(400, 'itemIds must list every queued message');
    }
    // Re-submitting assigns fresh ids in the new order, so mimic that (the client reloads /queue).
    conversation.inbox = ids.map((id) => ({
      ...(byId.get(id) as { mode: 'steer' | 'followUp'; content: string }),
      id: nextSubmissionId(),
    }));
    emit(conversation.id, 'submission');
    emit(conversation.id, 'inbox_update');
    return ok({ ok: true });
  }
  if (action === 'fork' && method === 'POST') {
    const fork = makeConversation({
      cwd: conversation.cwd,
      title: conversation.title ? `${conversation.title} (fork)` : undefined,
      model: conversation.model,
      thinkingLevel: conversation.thinkingLevel,
      entries: conversation.entries.map((entry) => ({ ...entry })),
    });
    conversations.push(fork);
    return ok(summaryOf(fork), 201);
  }
  if (action === 'btw' && method === 'POST') {
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return fail(400, 'question is required');
    const existingAsides = conversations.filter(
      (c) => c.lead?.conversationId === conversation.id && c.title?.startsWith('Aside #')
    ).length;
    const worker = makeConversation({
      cwd: conversation.cwd,
      title: `Aside #${existingAsides + 1}`,
      model: conversation.model,
      thinkingLevel: conversation.thinkingLevel,
      kind: 'worker',
      lead: { conversationId: conversation.id, host: 'local' },
      delegates: false,
      entries: conversation.entries.map((entry) => ({ ...entry })),
    });
    conversations.push(worker);
    worker.entries.push({
      id: nextEntryId(),
      kind: 'pi.user',
      model: [userMessage(question)],
    });
    worker.busy = true;
    emit(worker.id, 'run_start');
    schedule(worker, 400, () => {
      const answer = `Answered side question: ${question}`;
      worker.entries.push({
        id: nextEntryId(),
        kind: 'pi.assistant',
        model: [assistantMessage(text(answer), 'stop')],
      });
      worker.busy = false;
      emit(worker.id, 'run_end');
      // Wake the leader with the side-question report card.
      conversation.entries.push({
        id: nextEntryId(),
        kind: 'pi.user',
        model: [
          userMessage(
            `[crew] Side question:\nYou asked: "${question.slice(0, 300)}"\n${worker.title} (reported): ${answer} (conversation ${worker.id})`
          ),
        ],
      });
      emit(conversation.id, 'run_end');
    });
    return ok(summaryOf(worker), 201);
  }
  if (action === 'promote' && method === 'POST') {
    // Human promotion (§4): fork the idle worker into a named, ownerless peer, keep `lead` as
    // history, register the name locally, and link the worker to the fork.
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail(400, 'name is required');
    if (conversation.kind !== 'worker') return fail(400, 'only a worker can be promoted');
    if (conversation.busy) return fail(409, 'the worker is busy — wait or stop it first');
    if (agentNames.has(name)) return fail(400, `the name "${name}" is already registered on this host`);
    const peer = makeConversation({
      cwd: conversation.cwd,
      title: name,
      model: conversation.model,
      thinkingLevel: conversation.thinkingLevel,
      kind: 'peer',
      ...(conversation.lead ? { lead: conversation.lead } : {}),
      delegates: true,
      entries: conversation.entries.map((entry) => ({ ...entry })),
    });
    conversations.push(peer);
    agentNames.set(name, peer.id);
    conversation.promotedTo = peer.id;
    emit(conversation.id, 'run_end');
    emit(peer.id, 'run_end');
    return ok(summaryOf(peer), 201);
  }
  if (action === 'reset' && method === 'POST') {
    const handoff = typeof body.handoff === 'string' ? body.handoff : undefined;
    conversation.entries.push({ id: nextEntryId(), kind: 'pi.reset' });
    if (handoff) conversation.entries.push({ id: nextEntryId(), kind: 'pi.system', model: [userMessage(handoff)] });
    emit(conversation.id, 'run_end');
    return ok({ ok: true });
  }
  if (action === 'configure' && method === 'POST') {
    const model = body.model as { provider?: string; modelId?: string } | undefined;
    if (model?.provider && model?.modelId) conversation.model = { provider: model.provider, modelId: model.modelId };
    if (body.thinkingLevel !== undefined) {
      conversation.thinkingLevel = body.thinkingLevel === null ? undefined : String(body.thinkingLevel);
    }
    if (typeof body.cwd === 'string') conversation.cwd = body.cwd;
    emit(conversation.id, 'submission');
    return ok({ ok: true });
  }
  if (action === 'auto-accept' && (method === 'PUT' || method === 'POST')) {
    conversation.autoAccept.enabled = body.enabled === true;
    emit(conversation.id, 'submission');
    return ok({ ok: true });
  }
  const submissionMatch = /^submissions\/(\d+)\/abort$/.exec(action);
  if (submissionMatch && method === 'POST') {
    conversation.inbox = conversation.inbox.filter((item) => String(item.id) !== submissionMatch[1]);
    emit(conversation.id, 'submission');
    return ok({ ok: true });
  }
  return fail(404, 'not found');
};

const models = [
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    provider: 'faux-hearth',
    type: 'chat',
    reasoning: true,
    input: ['text'],
    cost: { input: 0.15, output: 0.5 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    thinkingLevelMap: { low: 'low', high: 'high' },
  },
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    provider: 'faux-hearth',
    type: 'chat',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0.15, output: 0.6 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
  },
];

// The providers the mock host reports on `/providers`; a credential map backs set/remove.
const providers = [
  { id: 'faux-hearth', name: 'Faux Harness', signIn: null },
  { id: 'opencode', name: 'OpenCode Zen', signIn: null },
  { id: 'deepseek', name: 'DeepSeek', signIn: null },
  {
    id: 'xai',
    name: 'xAI',
    signIn: { label: 'Sign in with SuperGrok or X Premium' },
  },
];
const providerCredentials = new Map<string, 'api_key' | 'oauth'>(new URLSearchParams(window.location.search).has('noProviders') ? [] : [['faux-hearth', 'api_key']]);
/** In-flight mock sign-ins, keyed by provider id. */
const mockLogins = new Map<string, { polls: number }>();

const mockFolders: Record<string, string[]> = {
      '/': ['workspace', 'Users'],
      '/workspace': ['habit', 'channels', 'ember'],
      '/workspace/habit': ['src', 'docs'],
      '/workspace/habit/src': [], '/workspace/habit/docs': [],
      '/workspace/channels': [], '/workspace/ember': [],
      '/Users': ['alex'], '/Users/alex': ['Work'],
      '/Users/alex/Work': ['Website', 'Research'],
      '/Users/alex/Work/Website': [], '/Users/alex/Work/Research': [],
    };

// ---- Bridge ---------------------------------------------------------------------------

/**
 * Read state survives a page reload, like the real thing (it lives in Ember's settings file).
 * Read marks, notification policy, defaults and appearance are kept within the browser context. localStorage rather than sessionStorage, because "relaunch and
 * the dot is still gone" is exactly what the read-state tests check.
 */
const READ_STATE_KEY = 'ember-pi-read-state';

const storedReadState = (): Partial<Pick<EmberSettings, 'readMarks' | 'readSince' | 'mutedSessions' | 'instanceDefaults' | 'avatarOverrides' | 'theme' | 'blobStyle' | 'conversationFontSize'>> => {
  try {
    return JSON.parse(window.localStorage.getItem(READ_STATE_KEY) ?? 'null') ?? {};
  } catch {
    return {};
  }
};

const storedRead = storedReadState();

let settings: EmberSettings = {
  theme: storedRead.theme ?? 'stone',
  blobStyle: storedRead.blobStyle ?? 'buddy',
  blobSize: 'standard',
  conversationFontSize: storedRead.conversationFontSize ?? 14,
  sessionWindowHours: 48,
  hiddenInstances: [],
  dismissedOutages: [],
  hideToolCalls: false,
  reasoningDisplay: 'collapsed',
  showQuestions: true,
  expandToolCalls: false,
  toolDisplay: 'collapsed',
  showMessageDetails: true,
  showAvatars: true,
  compactSpacing: false,
  compactRail: false,
  railMode: 'normal' as const,
  autoFollow: true,
  splitView: false,
  showActivityRail: true,
  sessionGroups: [],
  instanceDefaults: storedRead.instanceDefaults ?? {},
  sessionNotes: {},
  // The mock is a fresh install with no read history: every finished assistant turn is unread,
  // which is what Home's cards and the per-message bubbles need to exercise.
  readMarks: storedRead.readMarks ?? {},
  readSince: storedRead.readSince ?? 0,
  mutedSessions: storedRead.mutedSessions ?? [],
  composerDrafts: {},
  scheduledSessionBindings: {},
  autoArchiveScheduledRuns: true,
  avatarOverrides: parseAvatarOverrides(storedRead.avatarOverrides),
  projectColorAssignments: {},
  openSessions: fixtureParam === 'long-messages' ? ['pi:hearth::10'] : [],
  activeSession: fixtureParam === 'long-messages' ? 'pi:hearth::10' : null,
  minimizedSessions: [],
  piEndpoints: firstRunFixture
    ? []
    : [
        {
          // The onboarding fixture reports this as the local harness, so `localReady` is true and the
          // guide shows its five-step, connected-here path. Every other fixture keeps `pi:hearth`, so
          // the ordinary mock is a *remote* host — which is what the rest of the suite expects.
          id: onboardingFixture ? 'pi:local' : ENDPOINT_ID,
          label: onboardingFixture ? 'This computer' : 'ember-harness (mock)',
          url: ENDPOINT.url ?? '',
          token: 'mock-token',
        },
      ],
  // The mock stands in for an app that started its own harness, so Settings → Instances → This
  // computer has something to show and rotate in a plain browser. The first-run fixture is the
  // opposite: a harness that did not start, so the guide's failure copy is what a person sees.
  localHarnessCanRotate: !firstRunFixture,
  // `onboardedAt` is what suppresses the guide on an existing install; the fixture omits it.
  ...(onboardingFixture ? { onboardingStartedAt: 1, onboardingDismissedAt: undefined, onboardedAt: undefined } : {}),
  localHarnessState: firstRunFixture
    ? {
        kind: 'failed',
        notice:
          'The local Kiln server did not start: it did not answer on 127.0.0.1:3002 within 20s. You can still add a host in Settings → Instances. Log: ~/.ember/kiln.log',
      }
    : { kind: 'started', url: 'http://127.0.0.1:3002', notice: null },
  remoteAccessEnabled: false,
  remotePasswordConfigured: false,
};

/** Stands in for `~/.ember/hearth.token`, so the rotate button does something visible in the mock. */
let mockHarnessToken = 'amber-anchor-brisk-copper';

export const bridge: EmberBridge = {
  appName: 'Ember',
  capabilities: { dockIcon: false },
  listInstances: async () => {
    if (firstRunFixture) return [];
    if (outageFixture) return [ENDPOINT, OUTAGE_ENDPOINT];
    // The onboarding fixture reports the mock as the *local* host, so the id has to match the
    // endpoint it is listed from; a mismatch reads as one working remote and no local host.
    return [onboardingFixture ? { ...ENDPOINT, id: 'pi:local', label: 'This computer' } : ENDPOINT];
  },
  getSettings: async () => settings,
  localHarnessToken: async (options?: { rotate?: boolean }) => {
    if (options?.rotate) {
      mockHarnessToken = generateToken();
    }
    return { ok: true, canManage: true, token: mockHarnessToken, url: ENDPOINT.url ?? 'http://127.0.0.1:3002' };
  },
  setSettings: async (patch: EmberSettingsPatch) => {
    const { remotePassword: _remotePassword, composerDraftChanges, ...safe } = patch;
    const drafts = { ...settings.composerDrafts };
    for (const [key, draft] of Object.entries(composerDraftChanges ?? {})) {
      if (draft === null) delete drafts[key];
      else drafts[key] = draft;
    }
    settings = { ...settings, ...safe, ...(patch.avatarOverrides ? { avatarOverrides: parseAvatarOverrides(patch.avatarOverrides) } : {}), ...(composerDraftChanges ? { composerDrafts: drafts } : {}) };
    if (patch.readMarks !== undefined || patch.readSince !== undefined || patch.mutedSessions !== undefined || patch.instanceDefaults !== undefined || patch.avatarOverrides !== undefined || patch.theme !== undefined || patch.blobStyle !== undefined || patch.conversationFontSize !== undefined) {
      window.localStorage.setItem(
        READ_STATE_KEY,
        JSON.stringify({ readMarks: settings.readMarks, readSince: settings.readSince, mutedSessions: settings.mutedSessions, instanceDefaults: settings.instanceDefaults, avatarOverrides: settings.avatarOverrides, theme: settings.theme, blobStyle: settings.blobStyle, conversationFontSize: settings.conversationFontSize })
      );
    }
    return settings;
  },
  appVersion: async () => '0.25.0-dev',
  checkForUpdate: async () => {
    const mockLatest = new URLSearchParams(window.location.search).get('updateAvailable');
    if (mockLatest) {
      return {
        updateAvailable: true,
        currentVersion: '0.94.2',
        latestVersion: mockLatest,
        releaseUrl: `https://github.com/noemit/ember-bots/releases/tag/v${mockLatest}`,
      };
    }
    return {
      updateAvailable: false,
      currentVersion: '0.94.2',
      latestVersion: null,
      releaseUrl: 'https://github.com/noemit/ember-bots/releases',
    };
  },
  openExternal: async (target) => {
    if (/^https?:\/\//i.test(target)) window.open(target, '_blank', 'noopener');
    return true;
  },
  setAppIcon: async () => ({ ok: true }),
  // The real bridge appends to `ember-compact.log` in main; the mock keeps the same lines in
  // localStorage so a test can read back what the renderer reported.
  reportCompaction: async (line: string) => {
    const key = 'ember-compact-log';
    const previous = window.localStorage.getItem(key) ?? '';
    window.localStorage.setItem(key, `${previous}${line}\n`);
    return { ok: true };
  },
  request: async () => ({ ok: false, status: 404, data: { error: 'This mock serves the Hearth (pi) wire.' } }),
  piRequest: piRequest as EmberBridge['piRequest'],
  onEvent: (listener) => {
    eventListeners.add(listener);
    listener({ instanceId: ENDPOINT_ID, type: 'ember:stream-status', connected: true });
    return () => {
      eventListeners.delete(listener);
    };
  },
  eventStatus: async () => ({ [ENDPOINT_ID]: true }),
  getModelStats: async () => [],
  observeModels: async () => [],
  clearModelStats: async () => {},
  activityList: async () => ({ entries: [], cursor: undefined }),
  activitySearch: async () => ({ entries: [], cursor: undefined }),
  activityDays: async () => [],
  activityClear: async () => {},
};

// Keep the exported helpers referenced for tests/fixtures.
export const mockInternals = { conversations };
