/**
 * The pi side of the api layer: the same function shapes as the OpenChamber paths, but
 * served over the Hearth wire (`piRequest` through the bridge) and mapped by
 * `src/lib/piMapping.ts`. `src/api.ts` dispatches per instance kind; App stays agnostic.
 *
 * Parity: the queue is wired (`GET /queue`; rows, withdraw, send-now-as-steer) and so is
 * server-side auto-accept (the conversation summary's `autoAccept` flag drives the policy).
 * Attachments ride the submission as pi-ai content parts (text + images) — see `piInputContent`;
 * agent-mode mapping stays client-side.
 */
import { liveToolOutputs, piConversationToSession, piEntriesToMessages, piInboxToQueuedMessages, piModelsToModelList, piApprovalToPermissionRequest, piQuestionToQuestionRequest, toolResultSettlements } from './lib/piMapping';
import { randomId } from './lib/randomId';
import type { DirectoryAgent } from './lib/agentDirectory';
import { abortReceiptOf } from './lib/sendDelivery';
import { SessionCreateError } from './lib/sessionCreateError';
import type {
  LiveToolOutput,
  PiConversationSummary,
  PiEntry,
  PiHostMemory,
  PiLeftProcess,
  PiLive,
  PiModel,
  PiProcessStopResult,
  ToolResultSettlement,
} from './lib/piMapping';
import type { ModelList, PromptInput } from './api';
import type {
  FileAttachment,
  MessageQueueMutation,
  MessageQueueSession,
  MessageQueueSnapshot,
  MessageQueueTakeMutation,
  PermissionReply,
  PermissionRequest,
  QuestionAnswers,
  QuestionRequest,
  Session,
} from './types';
import { sessionKey } from './types';

/**
 * A full-history walk reads this many entries per request and stops at the cap.
 *
 * The page is small enough that one screenshot-heavy page stays well under the 32 MB response cap,
 * and the cap matches the legacy ceiling so a conversation Ember used to open still opens. Hitting
 * it is not silent: `complete` is false and the transcript offers to load the rest.
 */
const PI_HISTORY_PAGE_SIZE = 100;
const PI_HISTORY_MAX_ENTRIES = 8_000;

/**
 * Hearth's cap on one entries page (`LIMIT_MAX` in `hearth/src/server.ts`). It is 100 since Hearth
 * 0.35.0, down from 500, because a row can carry megabytes of base64 and the read parses every row
 * it selects. Asking for more is a 400, not a clamp, so every request this client makes stays at or
 * under the cap and pages with the cursor instead.
 */
const PI_ENTRY_LIMIT_MAX = 100;

/** Instance kinds remembered from `listInstances`, so api functions can dispatch. */
const piEndpointIds = new Set<string>();

export const rememberPiInstances = (instances: readonly { id: string; kind: string }[]): void => {
  piEndpointIds.clear();
  instances.filter((instance) => instance.kind === 'pi').forEach((instance) => piEndpointIds.add(instance.id));
};

export const isPiInstance = (instanceId: string): boolean => piEndpointIds.has(instanceId);

const request = async <T,>(
  endpointId: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<{ ok: boolean; status: number; data: T }> => {
  const bridge = window.ember;
  if (!bridge.piRequest) {
    return { ok: false, status: 0, data: {} as T };
  }
  return bridge.piRequest<T>(endpointId, path, init);
};

/**
 * A list field Ember may treat as authoritative, or `null` when the body does not carry one.
 *
 * The distinction is the whole point: an *empty* list is a host saying "I have none", and it may
 * clear what Ember shows. A body that is not a list at all is a host (or a proxy in front of it)
 * that did not answer the question — HTML from an SSO page, `null`, `{error}`, a number, a body cut
 * short mid-frame — and must not be read as "none". Collapsing the two erased every session in the
 * rail for an instance until the next good poll, with no error anywhere: the response was `ok`.
 * `null` is the api layer's existing "no answer" contract, which callers already handle by keeping
 * whatever they had.
 */
const parseConversations = (data: unknown): PiConversationSummary[] | null => {
  const list = (data as { conversations?: unknown } | null | undefined)?.conversations;
  return Array.isArray(list) ? (list as PiConversationSummary[]) : null;
};

/** The same rule for any other `{ <field>: [...] }` body. */
const parseListField = <T,>(data: unknown, field: string): T[] | null => {
  const list = (data as Record<string, unknown> | null | undefined)?.[field];
  return Array.isArray(list) ? (list as T[]) : null;
};

/**
 * Apply the sticky agent settings a send carries, before its content is submitted.
 *
 * The reasoning level is a conversation setting of its own: an Alt+Enter that picks `high` while
 * the model stays on `Server default` still has to reach the host, so `thinkingLevel` alone is a
 * valid configure (Hearth's `parseAgentChange` takes each field independently). Skipping this
 * whenever no model was named meant a reasoning choice made on a default-model session was
 * silently dropped: the message ran at the level the conversation already had.
 */
const piConfigureForSend = async (
  endpointId: string,
  conversationId: string,
  input: PromptInput
): Promise<{ ok: boolean; status: number; data: unknown } | null> => {
  if (!input.model && !input.variant) return null;
  return request(endpointId, `/conversations/${encodeURIComponent(conversationId)}/configure`, {
    method: 'POST',
    body: {
      ...(input.model
        ? { model: { provider: input.model.providerID, modelId: input.model.modelID } }
        : {}),
      ...(input.variant !== undefined ? { thinkingLevel: input.variant || null } : {}),
    },
  });
};

/**
 * Reply and queued-message context, as write entries the model reads and the transcript skips.
 *
 * `data` is what the transcript suppresses; `model` is what the agent actually reads. Hearth hands
 * a write entry's text to the model through `entry.model`, so an entry with only `data` was stored,
 * hidden, and silently unread. Both send paths share this, so a queued message cannot lose the
 * context its immediate send would have carried.
 */
const piWriteContexts = async (
  endpointId: string,
  conversationId: string,
  input: Pick<PromptInput, 'replyContext' | 'queuedContext'>
): Promise<{ ok: boolean; status: number; data: unknown } | null> => {
  const contexts: Array<{ text: string }> = [];
  if (input.replyContext) contexts.push({ text: `Earlier message being replied to:\n\n${input.replyContext}` });
  (input.queuedContext ?? []).forEach((entry) => {
    if (entry.instructions) contexts.push({ text: entry.instructions });
    contexts.push({ text: entry.text });
  });
  for (const context of contexts) {
    const written = await request(endpointId, `/conversations/${encodeURIComponent(conversationId)}/submit`, {
      method: 'POST',
      body: {
        type: 'write',
        entry: {
          kind: 'ember.reply-context',
          data: context,
          model: [{ role: 'user', content: [{ type: 'text', text: context.text }] }],
        },
        requestId: randomId(),
      },
    });
    if (!written.ok) return written;
  }
  return null;
};

// ---- Sessions ------------------------------------------------------------------------

export const piLoadSessions = async (endpointId: string): Promise<Session[] | null> => {
  const response = await request<{ conversations?: PiConversationSummary[]; host?: { memory?: PiHostMemory } }>(
    endpointId,
    '/conversations'
  );
  if (!response.ok) return null;
  const conversations = parseConversations(response.data);
  // Not a conversation list: keep the list Ember already had rather than emptying the rail.
  if (!conversations) return null;
  // The machine's memory arrives with the list, not per conversation: it is what decides whether a
  // session's leftovers are a status line or a warning, so every row of this poll shares one object.
  const hostMemory = response.data?.host?.memory;
  return conversations.map((conversation) => ({
    ...piConversationToSession(endpointId, conversation, Date.now()),
    ...(hostMemory ? { hostMemory } : {}),
  }));
};

/**
 * What one session left running, in full (the list's `items` are only the heaviest few), with the
 * host's memory level. `null` when the host did not answer.
 */
export const piLoadSessionProcesses = async (
  endpointId: string,
  conversationId: string
): Promise<{ processes: PiLeftProcess[]; memory?: PiHostMemory } | null> => {
  const response = await request<{ processes?: PiLeftProcess[]; host?: { memory?: PiHostMemory } }>(
    endpointId,
    `/conversations/${encodeURIComponent(conversationId)}/processes`
  );
  if (!response.ok) return null;
  const processes = Array.isArray(response.data.processes) ? response.data.processes : [];
  return { processes, memory: response.data.host?.memory };
};

/**
 * Stop processes a session left running. `force` is SIGKILL, the second step after a polite stop was
 * refused; the answer carries each outcome and the list *after*, so the caller redraws without a
 * second read. Processes the host no longer attributes to this session come back as `gone`.
 */
export const piStopSessionProcesses = async (
  endpointId: string,
  conversationId: string,
  options: { pids: number[]; force?: boolean }
): Promise<{ results: PiProcessStopResult[]; processes: PiLeftProcess[]; memory?: PiHostMemory } | null> => {
  const response = await request<{
    results?: PiProcessStopResult[];
    processes?: PiLeftProcess[];
    host?: { memory?: PiHostMemory };
  }>(endpointId, `/conversations/${encodeURIComponent(conversationId)}/processes/stop`, {
    method: 'POST',
    body: { pids: options.pids, ...(options.force ? { force: true } : {}) },
  });
  if (!response.ok) return null;
  return {
    results: Array.isArray(response.data.results) ? response.data.results : [],
    processes: Array.isArray(response.data.processes) ? response.data.processes : [],
    memory: response.data.host?.memory,
  };
};

/**
 * One host's named agents (`GET /directory`): its registry merged with live conversation status.
 *
 * `unsupported` is a real answer — an older Hearth, or any OpenChamber instance, serves no such route —
 * and must not be reported as an outage: the names are not missing, the feature is.
 */
export const piLoadDirectory = async (
  endpointId: string
): Promise<{ supported: boolean; agents: DirectoryAgent[] } | null> => {
  const response = await request<{ agents?: unknown }>(endpointId, '/directory');
  if (response.status === 404 || response.status === 405) return { supported: false, agents: [] };
  if (!response.ok) return null;
  const list = Array.isArray(response.data.agents) ? response.data.agents : [];
  const agents = list.flatMap((entry): DirectoryAgent[] => {
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) return [];
    const conversationId = record.conversationId;
    if (typeof conversationId !== 'number' && typeof conversationId !== 'string') return [];
    return [
      {
        name,
        host: typeof record.host === 'string' ? record.host : 'local',
        conversationId: String(conversationId),
        title: typeof record.title === 'string' ? record.title : undefined,
        kind: record.kind === 'worker' || record.kind === 'peer' ? record.kind : undefined,
        busy: record.busy === true,
        needsInput: record.needsInput === true,
        pinned: record.pinned === true,
        lastActivity: typeof record.lastActivity === 'number' ? record.lastActivity : undefined,
      },
    ];
  });
  return { supported: true, agents };
};

export const piLoadSessionStates = async (
  endpointId: string
): Promise<Record<string, 'idle' | 'active' | 'needs-input' | 'error'> | null> => {
  const response = await request<{ conversations?: PiConversationSummary[] }>(endpointId, '/conversations');
  if (!response.ok) return null;
  const conversations = parseConversations(response.data);
  // `null` rather than `{}`: an empty map is a claim that every conversation went idle.
  if (!conversations) return null;
  const states: Record<string, 'idle' | 'active' | 'needs-input' | 'error'> = {};
  conversations.forEach((conversation) => {
    const key = sessionKey({ instanceId: endpointId, sessionId: String(conversation.id) });
    // Busy comes from Hearth's summary; pending approvals/questions come from their lists,
    // which App merges per session from its own permission/question state.
    states[key] = conversation.busy ? 'active' : 'idle';
  });
  return states;
};

// ---- Transcript -----------------------------------------------------------------------

export const piLoadMessages = async (
  endpointId: string,
  conversationId: string
): Promise<{ messages: ReturnType<typeof piEntriesToMessages>; live?: PiLive; docs?: Record<string, unknown> }> => {
  const response = await request<{ entries?: PiEntry[]; docs?: Record<string, unknown> }>(
    endpointId,
    `/conversations/${encodeURIComponent(conversationId)}`
  );
  if (!response.ok) throw new Error(`Failed to load conversation ${conversationId}: ${response.status}`);
  const entries = Array.isArray(response.data.entries) ? response.data.entries : [];
  const live = (response.data.docs?.['pi.live'] as PiLive | undefined) ?? undefined;
  return { messages: piEntriesToMessages(entries, live, { authoritative: true }), live, docs: response.data.docs };
};

/**
 * A cheap tail: the newest `entryLimit` entries (paged newest-first) mapped to a chronological
 * message suffix. Tool-results whose call is outside the window are ignored, which is correct —
 * their assistant message is outside the window too. Used instead of fetching the whole snapshot
 * (which grows unbounded) for routine refreshes.
 */
export const piLoadMessageTail = async (
  endpointId: string,
  conversationId: string,
  entryLimit = 40,
  options: { withLive?: boolean } = {}
): Promise<ReturnType<typeof piEntriesToMessages>> => {
  const limit = Math.min(Math.max(entryLimit, 1), PI_ENTRY_LIMIT_MAX);
  // `docs=1` asks Hearth for the conversation's documents alongside the page (a few hundred bytes).
  // Without them a tail read cannot see `pi.live`, so the in-flight generation - the reasoning and
  // text being written right now - was invisible until the turn ended and it became an entry. That
  // is why thinking looked like it arrived late rather than streaming.
  const withLive = options.withLive !== false;
  const query = `limit=${limit}${withLive ? '&docs=1' : ''}`;
  const response = await request<{ entries?: PiEntry[]; docs?: Record<string, unknown> }>(
    endpointId,
    `/conversations/${encodeURIComponent(conversationId)}/entries?${query}`
  );
  if (!response.ok) throw new Error(`Failed to load conversation ${conversationId} entries: ${response.status}`);
  const entries = Array.isArray(response.data.entries) ? [...response.data.entries].reverse() : [];
  const live = withLive ? ((response.data.docs?.['pi.live'] as PiLive | undefined) ?? undefined) : undefined;
  return piEntriesToMessages(entries, live, { authoritative: true });
};

/**
 * An incremental read: entries *newer* than `since`, and nothing else.
 *
 * The tail above re-reads 40 whole entry records on every streaming hint -- measured 21.3MB for a
 * session carrying screenshots, almost all of it unchanged since the previous read. `since` makes
 * the cost proportional to what actually changed: nothing, when nothing did.
 *
 * `complete` is false when the answer was cut short (the server reports a `next` cursor), which means
 * entries in between were left out. The caller must then take the overlap-based tail path instead of
 * appending -- appending a gapped read would silently drop messages.
 */
export const piLoadMessageAppend = async (
  endpointId: string,
  conversationId: string,
  since: number,
  entryLimit = 40
): Promise<{
  messages: ReturnType<typeof piEntriesToMessages>;
  complete: boolean;
  /**
   * Results whose call was committed by an earlier page. The caller applies them to the transcript
   * it already holds (`settleToolResults`); mapping alone cannot, because the call is not in this
   * page and the result carries no message of its own.
   */
  settlements: ToolResultSettlement[];
  /**
   * The output of tool calls still executing. The page is usually empty (the call was committed by
   * an earlier read), but this rides along in `docs["pi.live"]` on the same request, so a running
   * command's streamed output is patched onto the row already on screen.
   */
  liveOutputs: LiveToolOutput[];
}> => {
  const limit = Math.min(Math.max(entryLimit, 1), PI_ENTRY_LIMIT_MAX);
  const response = await request<{ entries?: PiEntry[]; docs?: Record<string, unknown>; next?: unknown }>(
    endpointId,
    `/conversations/${encodeURIComponent(conversationId)}/entries?limit=${limit}&docs=1&since=${since}`
  );
  if (!response.ok) throw new Error(`Failed to load conversation ${conversationId} entries: ${response.status}`);
  const entries = Array.isArray(response.data.entries) ? [...response.data.entries].reverse() : [];
  const live = (response.data.docs?.['pi.live'] as PiLive | undefined) ?? undefined;
  // Not authoritative: a call in this page may get its result in a later one. A result whose call
  // was settled earlier is carried separately rather than dropped with the empty mapping.
  return {
    messages: piEntriesToMessages(entries, live),
    complete: response.data.next === undefined,
    settlements: toolResultSettlements(entries),
    liveOutputs: liveToolOutputs(live),
  };
};

/**
 * Walks `GET /conversations/:id/entries` newest-first pages back to the start of the conversation
 * and returns them oldest-first, with whether it actually reached the start.
 *
 * `complete` is the load-bearing part: a cap or a server that stops answering leaves it false, and
 * the caller must then say the history above the window is missing rather than call it complete.
 * `fetchPage` is injected so the walk (ordering, stopping, cap) is testable without a bridge.
 *
 * The walk also has to survive a host that repeats itself, because nothing else does. A cursor the
 * host ignores, an offset-based route whose pages overlap, or a proxy replaying a response all hand
 * back entries already collected, and appending them again duplicates the transcript — measured in
 * the dev harness, where a 4-entry conversation rendered as 800 messages (every page past the first
 * was the same page, pushed 200 times, with duplicate React keys). So entries are deduplicated by
 * id across pages, and a page that contributes nothing new ends the walk where it stands: paging has
 * stopped making progress, and a host that repeats itself has not told us it reached the beginning.
 * That stop is therefore *not* complete — the reader then offers to load more rather than claiming
 * the history is whole on the strength of a bug.
 */
export const collectHistoryPages = async (
  fetchPage: (cursor?: unknown) => Promise<{ entries: PiEntry[]; next?: unknown }>,
  options: { maxEntries?: number } = {}
): Promise<{ entries: PiEntry[]; complete: boolean }> => {
  const maxEntries = Math.max(options.maxEntries ?? PI_HISTORY_MAX_ENTRIES, 1);
  const collected: PiEntry[] = [];
  const seen = new Set<PiEntry['id']>();
  let cursor: unknown;
  // A server that kept handing back a cursor would otherwise spin here for ever; 200 pages is far
  // beyond any real conversation at this page size and still bounded. A repeating page normally
  // stops the walk long before this, on the "nothing new" rule below — two requests, not two hundred.
  for (let page = 0; page < 200; page += 1) {
    const answer = await fetchPage(cursor);
    let added = 0;
    for (const entry of answer.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      collected.push(entry);
      added += 1;
    }
    // A genuine end: the host says there is nothing older, or answers with an empty page (which is
    // the same statement in page form).
    if (answer.next === undefined || answer.entries.length === 0) {
      return { entries: collected.reverse(), complete: true };
    }
    // A page with nothing new (a repeated page, or one entirely inside the previous window's
    // overlap) is treated exactly like an empty one: it ends the walk. But it is *not* evidence of
    // the start of the conversation, so the walk reports incomplete instead of claiming more.
    if (added === 0) break;
    cursor = answer.next;
    if (collected.length >= maxEntries) break;
  }
  // Pages arrive newest-first, so reversing once at the end leaves a chronological transcript.
  return { entries: collected.reverse(), complete: false };
};

/**
 * The whole conversation, in bounded pages.
 *
 * `GET /conversations/:id` is *not* the whole transcript: it serves the active window, which after a
 * compaction is a fraction of the history (measured live: 39 of 872 entries on one conversation, 727
 * of 1,822 on another). A "full" read built on it marked a partial history as complete, and the
 * reader had no way to know. Paging the entries route is also the only way a conversation larger
 * than the response cap can be opened at all.
 *
 * The first page also asks for the conversation's documents (`docs=1`): a few hundred bytes, and the
 * only way this read can see `pi.live` — the in-flight generation and its running tool slots. Without
 * it a full repair that lands mid-turn mapped every open call as unsettled and pushed a whole-history
 * snapshot into a streaming turn with no idea a run was active, which is how a live step showed up as
 * interrupted. The documents describe the newest state, so they are not carried across pages.
 */
export const piLoadMessageHistory = async (
  endpointId: string,
  conversationId: string
): Promise<{ messages: ReturnType<typeof piEntriesToMessages>; complete: boolean }> => {
  let live: PiLive | undefined;
  const { entries, complete } = await collectHistoryPages(async (cursor) => {
    const params = new URLSearchParams();
    params.set('limit', String(PI_HISTORY_PAGE_SIZE));
    if (cursor !== undefined) params.set('cursor', JSON.stringify(cursor));
    else params.set('docs', '1');
    const response = await request<{ entries?: PiEntry[]; next?: unknown; docs?: Record<string, unknown> }>(
      endpointId,
      `/conversations/${encodeURIComponent(conversationId)}/entries?${params.toString()}`
    );
    if (!response.ok) {
      // The transport's own words when it has them. A body over the response cap is refused in main
      // with "Response body is too large", and that sentence is the whole difference between a read
      // that will fail again next time (the breaker in `lib/repairBudget` counts on it) and one that
      // will not: rewrapping it as a status code threw the distinction away.
      const said = (response.data as { error?: unknown } | null)?.error;
      throw new Error(
        typeof said === 'string' && said.trim()
          ? said
          : `Failed to load conversation ${conversationId} history (${response.status || 'no response'}).`
      );
    }
    if (cursor === undefined) live = (response.data.docs?.['pi.live'] as PiLive | undefined) ?? undefined;
    return {
      entries: Array.isArray(response.data.entries) ? response.data.entries : [],
      next: response.data.next,
    };
  });
  // One mapping pass over the whole thing: every tool call and its result are in hand, so a call is
  // settled by its real result rather than left pending, and a call with none in a finished turn is
  // the interruption it actually was. `live` says which turn, if any, is still running.
  return { messages: piEntriesToMessages(entries, live, { authoritative: true }), complete };
};

/**
 * The standing instructions a session already has, read back from its agent document.
 *
 * `docs=1` on a one-entry page is the cheap read: the agent doc rides along with any entries request,
 * while `GET /conversations/:id` would carry the whole transcript to deliver one string. Absent
 * `instructions` means the session has none — a session created before this existed, or one where
 * they were cleared.
 */
export const piLoadSessionInstructions = async (
  endpointId: string,
  conversationId: string
): Promise<{ supported: boolean; instructions?: string }> => {
  const response = await request<{ docs?: Record<string, unknown> }>(
    endpointId,
    `/conversations/${encodeURIComponent(conversationId)}/entries?limit=1&docs=1`
  );
  if (!response.ok) {
    throw new Error(`Failed to read conversation ${conversationId} instructions: ${response.status}`);
  }
  const agent = response.data.docs?.['pi.agent'] as { instructions?: unknown } | undefined;
  return {
    supported: true,
    instructions: typeof agent?.instructions === 'string' ? agent.instructions : undefined,
  };
};

/** Set a session's standing instructions; `null` clears them. */
export const piSetSessionInstructions = async (
  endpointId: string,
  conversationId: string,
  instructions: string | null
): Promise<boolean> => {
  const response = await request(endpointId, `/conversations/${encodeURIComponent(conversationId)}/configure`, {
    method: 'POST',
    body: { instructions },
  });
  return response.ok;
};

// ---- Actions --------------------------------------------------------------------------

/** A `data:` URL split into the mime type and payload Hearth's image content part wants. */
const dataUrlOf = (url: string): { mimeType: string; data: string } | undefined => {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (!match) return undefined;
  const data = match[2];
  return match[1] && data ? { mimeType: match[1], data } : undefined;
};

/**
 * Attachments Hearth cannot carry: it takes images, and everything else the agent reads from disk
 * itself. Refusing here keeps the message accurate (it used to refuse images too).
 */
const nonImageAttachments = (attachments: FileAttachment[] | undefined): FileAttachment[] =>
  (attachments ?? []).filter((file) => !file.mime.startsWith('image/'));

const unsupportedAttachmentsError = (files: FileAttachment[]) => ({
  ok: false as const,
  status: 400,
  data: {
    error:
      files.length === 1
        ? `Only images can be attached to an ember-harness message (${files[0].filename} is not one) — save the file and ask the bot to read it.`
        : `Only images can be attached to an ember-harness message (${files.length} files are not images) — save them and ask the bot to read them.`,
  },
});

/**
 * Hearth's submission content: plain text, or text with images. pi-ai's user content is
 * `string | (TextContent | ImageContent)[]` and Hearth accepts exactly that, so an attachment
 * becomes an image part carrying its base64 payload — the composer already read the file into a
 * `data:` URL. An attachment without readable data (a history row, not a fresh file) is dropped
 * rather than sent as an empty part, and a message that ends up with nothing is left to the
 * server to refuse, since only it can say why.
 */
export const piInputContent = (
  text: string,
  attachments: FileAttachment[] | undefined
): string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> => {
  const images = (attachments ?? []).flatMap((file) => {
    const parsed = dataUrlOf(file.url);
    return parsed === undefined ? [] : [{ type: 'image' as const, ...parsed }];
  });
  if (images.length === 0) return text;
  return [...(text.trim() ? [{ type: 'text' as const, text }] : []), ...images];
};

/**
 * Submit, and try once more if the connection dropped before any response arrived.
 *
 * `status: 0` is not a refusal: it means no HTTP response came back at all, so the socket failed
 * rather than the server saying no. Over a tailnet that is routine — Hearth restarts to pick up a
 * change, the link blips mid-request — and the old behaviour turned it into a red "Not sent" bubble
 * for a message that may well have landed.
 *
 * Retrying is only safe because the *same* `requestId` travels with both attempts. Hearth dedupes on
 * it (pi-durable's `submissionByRequest`), so a request that did arrive returns its original
 * submission instead of posting the message a second time. Without the id this would be a
 * double-send, which is why the id came first.
 */
const submitRequest = async (
  endpointId: string,
  conversationId: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data: unknown }> => {
  const path = `/conversations/${encodeURIComponent(conversationId)}/submit`;
  const requestId = randomId();
  const first = await request(endpointId, path, { method: 'POST', body: { ...body, requestId } });
  if (first.ok || first.status !== 0) return first;
  await new Promise((resolve) => setTimeout(resolve, 400));
  return request(endpointId, path, { method: 'POST', body: { ...body, requestId } });
};

export const piSendPrompt = async (
  endpointId: string,
  conversationId: string,
  input: PromptInput
): Promise<{ ok: boolean; status: number; data: unknown }> => {
  const unsupported = nonImageAttachments(input.attachments);
  if (unsupported.length > 0) return unsupportedAttachmentsError(unsupported);
  // A session created with this model and level already carries them (`piCreateSession` sends both),
  // so the first send does not need to write them again — one gratuitous round trip in front of the
  // message that is already on screen.
  const configure = input.configured ? null : await piConfigureForSend(endpointId, conversationId, input);
  if (configure && !configure.ok) return configure;
  const context = await piWriteContexts(endpointId, conversationId, input);
  if (context) return context;
  // The direct send path queues when the conversation is busy; Alt+Enter (`input.steer`)
  // steers the running turn instead. A stale busy state on the client can therefore never
  // turn a "queue this" into a steer. Idle conversations ignore whenBusy.
  return submitRequest(endpointId, conversationId, {
    type: 'input',
    content: piInputContent(input.text, input.attachments),
    whenBusy: input.steer ? 'steer' : 'followUp',
  });
};

export const piEnqueueMessage = async (
  endpointId: string,
  conversationId: string,
  input: PromptInput
): Promise<{ ok: boolean; status: number; data: unknown }> => {
  const unsupported = nonImageAttachments(input.attachments);
  if (unsupported.length > 0) return unsupportedAttachmentsError(unsupported);
  const configure = await piConfigureForSend(endpointId, conversationId, input);
  if (configure && !configure.ok) return configure;
  // The same reply/queued context an immediate send writes: a message parked in the inbox must reach
  // the model with the context it was written with, not silently without it.
  const context = await piWriteContexts(endpointId, conversationId, input);
  if (context) return context;
  const submitted = await request<{ submissionId?: number; status?: string }>(
    endpointId,
    `/conversations/${encodeURIComponent(conversationId)}/submit`,
    { method: 'POST', body: { type: 'input', content: piInputContent(input.text, input.attachments), whenBusy: 'followUp' } }
  );
  if (!submitted.ok) return submitted;
  // Return the refreshed queue as a mutation so the optimistic local row is replaced by the
  // server item instead of lingering as "pending". If the inbox read races the submit, add the
  // submitted item ourselves (its id is the submission id) so the row still reconciles.
  //
  // A *placed* submission is not queued at all: the host started it straight away, so there is no
  // row to adopt. Appending one put a phantom "Queue:" row on screen for a message that was already
  // running, and it vanished on the next read as if it had never been queued.
  const status = typeof submitted.data?.status === 'string' ? submitted.data.status.toLowerCase() : '';
  const placed = status === 'placed';
  const submitId = placed ? '' : String(submitted.data?.submissionId ?? '');
  const queue = await piLoadMessageQueue(endpointId);
  const session = queue?.sessions.find((entry) => entry.sessionId === conversationId) ?? {
    sessionId: conversationId,
    directory: '',
    items: [],
    sendingId: null,
  };
  if (submitId && !session.items.some((item) => item.id === submitId)) {
    session.items = [
      ...session.items,
      {
        id: submitId,
        createdAt: Date.now(),
        content: input.text,
        text: input.text,
        attachments: [],
        context: [],
        sendConfig: {
          providerID: input.model?.providerID ?? '',
          modelID: input.model?.modelID ?? '',
          ...(input.variant ? { variant: input.variant } : {}),
        },
      },
    ];
  }
  return { ok: true, status: submitted.status, data: { revision: queue?.revision ?? Date.now(), session, itemId: submitId } };
};

// ---- Queue ---------------------------------------------------------------------------

type PiQueueSession = {
  sessionId: number | string;
  directory?: string;
  model?: { provider?: string; modelId?: string };
  thinkingLevel?: string | null;
  sendingId?: string | null;
  items?: Array<{ id: number | string; mode?: string; text?: string; content?: unknown }>;
};

/**
 * Withdraw one queued submission, and say truthfully whether anything was withdrawn.
 *
 * Hearth answers HTTP 200 with `{ ok: false, result: "already_settled" }` when the submission has
 * already run (or was already withdrawn): the message is no longer queued, so there is nothing to
 * withdraw, and it is *not* a success. Ignoring `ok` meant "Cancel" on a message that had just been
 * placed reported it as cancelled, and "Send now" re-sent a message the host had already run.
 */
const piWithdrawSubmission = async (
  endpointId: string,
  conversationId: string,
  itemId: string
): Promise<{ ok: boolean; status: number }> => {
  const aborted = await request<{ ok?: boolean; result?: string } | null>(
    endpointId,
    `/conversations/${encodeURIComponent(conversationId)}/submissions/${encodeURIComponent(itemId)}/abort`,
    { method: 'POST', body: {} }
  );
  if (!aborted.ok) return { ok: false, status: aborted.status };
  // A 200 whose body says it did not happen is a refusal: report it as the conflict it is, so the
  // caller rolls its row back rather than claiming a withdrawal that never happened.
  if ((aborted.data as { ok?: boolean } | null | undefined)?.ok === false) {
    return { ok: false, status: 409 };
  }
  return { ok: true, status: aborted.status };
};

/** Hearth's aggregated inbox view, mapped onto Ember's queue snapshot. */
export const piLoadMessageQueue = async (endpointId: string): Promise<MessageQueueSnapshot | null> => {
  const response = await request<{ revision?: number; sessions?: PiQueueSession[] }>(endpointId, '/queue');
  if (!response.ok) return null;
  // A body without a sessions array is not a queue, so it must not clear the rows Ember shows.
  const rawSessions = parseListField<PiQueueSession>(response.data, 'sessions');
  if (!rawSessions) return null;
  const sessions = rawSessions.map(
    (session): MessageQueueSession => ({
      sessionId: String(session.sessionId),
      directory: session.directory ?? '',
      sendingId: session.sendingId ?? null,
      // Every inbox item the human wrote is shown, steers included. A steer is a real inbox item
      // that waits for the turn to pause, and leaving it out made a message the host still holds
      // invisible — and unwithdrawable, since withdrawal resolves items from this list. A `write`
      // is model-only context with nothing to render. The mapping itself lives in one place
      // (`piInboxToQueuedMessages`), so a queued image keeps its payload here exactly as it does
      // everywhere else.
      items: piInboxToQueuedMessages(
        endpointId,
        session.sessionId,
        (session.items ?? []).filter((item) => item.mode !== 'write'),
        {
          providerID: session.model?.provider ?? '',
          modelID: session.model?.modelId ?? '',
          variant: session.thinkingLevel ?? undefined,
        }
      ),
    })
  );
  return { revision: typeof response.data.revision === 'number' ? response.data.revision : 0, sessions };
};

const piQueueMutation = async (
  endpointId: string,
  sessionId: string,
  itemId?: string
): Promise<MessageQueueMutation | null> => {
  const queue = await piLoadMessageQueue(endpointId);
  if (!queue) return null;
  // A session with nothing queued is absent from /queue; represent it as empty so a withdrawal
  // clears the row instead of being dropped as a null mutation.
  const session = queue.sessions.find((entry) => entry.sessionId === sessionId) ?? {
    sessionId,
    directory: '',
    items: [],
    sendingId: null,
  };
  return { revision: queue.revision, session, itemId };
};

export const piRemoveQueuedMessage = async (
  endpointId: string,
  conversationId: string,
  itemId: string
): Promise<{ ok: boolean; status: number; data: MessageQueueMutation | null }> => {
  const withdrawn = await piWithdrawSubmission(endpointId, conversationId, itemId);
  if (!withdrawn.ok) return { ok: false, status: withdrawn.status, data: null };
  return { ok: true, status: withdrawn.status, data: await piQueueMutation(endpointId, conversationId, itemId) };
};

export const piTakeQueuedMessage = async (
  endpointId: string,
  conversationId: string,
  itemId: string
): Promise<{ ok: boolean; status: number; data: MessageQueueTakeMutation | null }> => {
  // Withdraw the queued submission and hand its payload back so the composer can steer it now.
  const queue = await piLoadMessageQueue(endpointId);
  const session = queue?.sessions.find((entry) => entry.sessionId === conversationId) ?? null;
  const item = session?.items.find((entry) => entry.id === itemId) ?? null;
  if (!item) return { ok: false, status: 404, data: null };
  const withdrawn = await piWithdrawSubmission(endpointId, conversationId, itemId);
  // "Send now" on a message that already ran must not hand its payload back: sending it again would
  // duplicate a message the host has placed. The row is stale, and the conflict says so.
  if (!withdrawn.ok) return { ok: false, status: withdrawn.status, data: null };
  const remaining = await piQueueMutation(endpointId, conversationId, itemId);
  return {
    ok: true,
    status: withdrawn.status,
    data: {
      revision: remaining?.revision ?? 0,
      session: remaining?.session ?? { sessionId: conversationId, directory: '', items: [], sendingId: null },
      itemId,
      item,
    },
  };
};

/**
 * Reorder queued follow-ups. Hearth's inbox places items in ID order, so the server withdraws each
 * queued input and re-submits them in the requested order (fresh ids); we re-read the queue so the
 * client reconciles from the server rows rather than the old ids.
 *
 * Hearth requires `itemIds` to list *every* queued message exactly once, steers included — and a
 * steer waits in the same inbox. The client only reorders the follow-ups it renders, so its list is
 * short whenever a steer is queued, and the host refuses it ("itemIds must list every queued
 * message, once") with nothing on screen to explain why. So the full inbox order is read here and
 * merged: a steer keeps its position among the follow-ups — it was not part of the requested move,
 * so it must not be moved — and the ids the caller sent are placed in the order it asked for.
 */
export const piReorderQueuedMessages = async (
  endpointId: string,
  conversationId: string,
  itemIds: string[]
): Promise<{ ok: boolean; status: number; data: MessageQueueMutation | null }> => {
  const before = await piLoadMessageQueue(endpointId);
  const queued = before?.sessions.find((entry) => entry.sessionId === conversationId)?.items ?? [];
  const orderedIds = mergeQueueOrder(
    queued.map((item) => item.id),
    itemIds
  );
  const response = await request(endpointId, `/conversations/${encodeURIComponent(conversationId)}/queue/order`, {
    method: 'PUT',
    body: { itemIds: orderedIds },
  });
  if (!response.ok) return { ok: false, status: response.status, data: null };
  return { ok: true, status: response.status, data: await piQueueMutation(endpointId, conversationId) };
};

/**
 * The whole inbox order: the requested ids in the requested order, with everything else the host
 * holds left where it was. Items the caller did not name (a steer, a row it has not rendered yet)
 * keep their slots, so a reorder of follow-ups never silently moves a steer to the front or the end.
 */
export const mergeQueueOrder = (currentIds: readonly string[], requested: readonly string[]): string[] => {
  const requestedSet = new Set(requested);
  const known = new Set(currentIds);
  let next = 0;
  const merged = currentIds.map((id) => (requestedSet.has(id) ? requested[next++] ?? id : id));
  // Ids the caller named that the queue read does not list (a stale/incomplete read) are kept, in
  // their requested order, at the end rather than dropped: Hearth refuses a list that omits a
  // queued message, so dropping one would turn a reorder into a hard failure.
  const missing = requested.filter((id) => !known.has(id));
  return [...merged, ...missing];
};

export const piCreateSession = async (
  endpointId: string,
  directory?: string,
  input?: {
    model?: { providerID: string; modelID: string };
    /**
     * The reasoning level the session starts at. Hearth takes `thinkingLevel` on the create exactly
     * as `/configure` does (`parseAgentChange`), so a level chosen while the model stays on the
     * server default is sent on its own rather than dropped.
     */
    variant?: string;
    /**
     * Standing instructions the session starts with. Hearth takes this on the create, so a session is
     * never briefly promptless: it is a reserved section of the system prompt (pi-durable's
     * `INSTRUCTIONS_KEY`), not a first message the model could ignore.
     */
    instructions?: string;
    /**
     * The display name, derived from the first message (see `lib/sessionNames`). Hearth stores it in
     * its own metadata, so the conversation is never briefly nameless — and every client agrees.
     */
    title?: string;
  }
): Promise<Session | null> => {
  const instructions = input?.instructions?.trim();
  const response = await request<PiConversationSummary>(endpointId, '/conversations', {
    method: 'POST',
    body: {
      ...(directory ? { cwd: directory } : {}),
      ...(input?.model ? { model: { provider: input.model.providerID, modelId: input.model.modelID } } : {}),
      ...(input?.variant ? { thinkingLevel: input.variant } : {}),
      ...(instructions ? { instructions } : {}),
      ...(input?.title ? { title: input.title } : {}),
    },
  });
  if (!response.ok) {
    // Carry Hearth's own reason (e.g. "folder does not exist: …") and the status, so the draft can
    // say which side failed and what to do about it. A 2xx whose body has no conversation is *not*
    // an error here: `null` is the api layer's "no answer", and the caller reports it as such.
    const message = (response.data as unknown as { error?: unknown } | null)?.error;
    throw new SessionCreateError(
      response.status,
      typeof message === 'string' ? message : undefined
    );
  }
  if (!response.data || typeof response.data.id !== 'number') return null;
  return piConversationToSession(endpointId, response.data, Date.now());
};

/**
 * Stop the running turn, and read what the stop kept.
 *
 * Hearth withdraws every queued input and re-parks it in the same mode (`parking.ts`), reporting how
 * many it kept and a preview of each. Returning bare `ok` threw that away, and the caller then had
 * to guess whether a steer that never ran was dropped or kept — which is how a message the host was
 * still holding got reported as "Not sent".
 */
export const piAbortSession = async (
  endpointId: string,
  conversationId: string
): Promise<{ ok: boolean; parked: number; parkedText: string[] }> => {
  const response = await request<{ parked?: unknown; parkedText?: unknown }>(
    endpointId,
    `/conversations/${encodeURIComponent(conversationId)}/abort`,
    { method: 'POST', body: {} }
  );
  return abortReceiptOf(response.ok, response.data);
};

export const piRenameSession = async (
  endpointId: string,
  conversationId: string,
  title: string
): Promise<boolean> => {
  const response = await request(endpointId, `/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    body: { title },
  });
  return response.ok;
};

export const piSetSessionArchived = async (
  endpointId: string,
  conversationId: string,
  archived: boolean
): Promise<boolean> => {
  const response = await request(endpointId, `/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    body: { archived: archived ? Date.now() : null },
  });
  return response.ok;
};

export const piLoadCompactionStatus = async (
  endpointId: string, conversationId: string, taskId: number
): Promise<import('./lib/compaction').CompactionTaskResult | null> => {
  const response = await request<{ status?: unknown; error?: unknown }>(endpointId,
    `/conversations/${encodeURIComponent(conversationId)}/compact/${taskId}`);
  if (!response.ok || !response.data) return null; // Older Kilns do not offer task status.
  const { status, error } = response.data;
  if (status !== 'running' && status !== 'pending' && status !== 'landed' && status !== 'nothing' && status !== 'failed' && status !== 'aborted') return null;
  return { status, ...(typeof error === 'string' ? { error } : {}) };
};

export type PiCompactionReceipt = {
  accepted: boolean;
  taskId?: number;
};

export const piCompactSession = async (
  endpointId: string,
  conversationId: string
): Promise<PiCompactionReceipt> => {
  const response = await request<{ taskId?: unknown }>(
    endpointId,
    `/conversations/${encodeURIComponent(conversationId)}/compact`,
    {
      method: 'POST',
      body: {},
    }
  );
  if (!response.ok) return { accepted: false };
  const taskId =
    response.data && typeof response.data.taskId === 'number' && Number.isFinite(response.data.taskId)
      ? response.data.taskId
      : undefined;
  return { accepted: true, ...(taskId !== undefined ? { taskId } : {}) };
};

/**
 * Ask a side question ("btw …"): forks the conversation on the host into a hidden `Aside #N`
 * worker carrying the leader's full context, submits the question, and reports its answer back
 * as a side-question card in the leader's transcript.
 */
export const piAskSideQuestion = async (
  endpointId: string,
  conversationId: string,
  question: string
): Promise<Session | null> => {
  const response = await request<PiConversationSummary>(
    endpointId,
    `/conversations/${encodeURIComponent(conversationId)}/btw`,
    {
      method: 'POST',
      body: { question },
    }
  );
  if (!response.ok || !response.data || typeof response.data.id !== 'number') return null;
  return piConversationToSession(endpointId, response.data, Date.now());
};

/**
 * Human promotion: fork an idle worker into a named, ownerless `peer` and
 * register the name locally. Hearth answers 201 with the new peer's conversation summary, or
 * 409 when the worker is busy / 400 when it is not a worker or the local name is taken — every
 * failure maps to `null` so the dialog can say the promotion didn't happen.
 */
export const piPromoteSession = async (
  endpointId: string,
  conversationId: string,
  input: { name: string; description?: string; pinned?: boolean }
): Promise<Session | null> => {
  const response = await request<PiConversationSummary>(
    endpointId,
    `/conversations/${encodeURIComponent(conversationId)}/promote`,
    {
      method: 'POST',
      body: {
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      },
    }
  );
  if (!response.ok || !response.data || typeof response.data.id !== 'number') return null;
  return piConversationToSession(endpointId, response.data, Date.now());
};


// ---- Models ---------------------------------------------------------------------------

export const piLoadModels = async (endpointId: string): Promise<ModelList | null> => {
  const response = await request<{ models?: PiModel[]; default?: { provider: string; modelId: string } }>(
    endpointId,
    '/models'
  );
  if (!response.ok) return null;
  const models = Array.isArray(response.data.models) ? response.data.models : [];
  const mapped = piModelsToModelList(models, response.data.default);
  return { models: mapped.models, defaultModelId: mapped.defaultModelId };
};

// ---- Approvals + questions ------------------------------------------------------------

export const piLoadPermissions = async (endpointId: string): Promise<PermissionRequest[] | null> => {
  const response = await request<{ approvals?: Array<{ conversationId: string; key: string; tool: string; arguments?: Record<string, unknown> }> }>(
    endpointId,
    '/approvals'
  );
  if (!response.ok) return null;
  const approvals = parseListField<{ conversationId: string; key: string; tool: string; arguments?: Record<string, unknown> }>(
    response.data,
    'approvals'
  );
  // A pending approval is the card that unblocks an agent: only a host that answered may clear it.
  if (!approvals) return null;
  return approvals.map((approval) => piApprovalToPermissionRequest(endpointId, approval));
};

export const piReplyPermission = async (
  endpointId: string,
  request_: PermissionRequest,
  reply: PermissionReply
): Promise<boolean> => {
  const [conversationId, key] = request_.id.split(':');
  const response = await request(
    endpointId,
    `/approvals/${encodeURIComponent(conversationId)}/${encodeURIComponent(key ?? '')}/reply`,
    { method: 'POST', body: { decision: reply } }
  );
  return response.ok;
};

export const piLoadQuestions = async (endpointId: string): Promise<QuestionRequest[] | null> => {
  const response = await request<{ questions?: Array<{ conversationId: string; key: string; question: string; options?: string[] }> }>(
    endpointId,
    '/questions'
  );
  if (!response.ok) return null;
  const questions = parseListField<{ conversationId: string; key: string; question: string; options?: string[] }>(
    response.data,
    'questions'
  );
  // Same rule as approvals: a parked question is the card the agent is waiting on.
  if (!questions) return null;
  return questions.map((question) => piQuestionToQuestionRequest(endpointId, question));
};

export const piReplyQuestion = async (
  endpointId: string,
  request_: QuestionRequest,
  answers: QuestionAnswers
): Promise<boolean> => {
  const [conversationId, key] = request_.id.split(':');
  const answer = (answers[0] ?? []).join('\n');
  const response = await request(
    endpointId,
    `/questions/${encodeURIComponent(conversationId)}/${encodeURIComponent(key ?? '')}/reply`,
    { method: 'POST', body: { answer } }
  );
  return response.ok;
};

export const piRejectQuestion = async (endpointId: string, request_: QuestionRequest): Promise<boolean> => {
  const [conversationId, key] = request_.id.split(':');
  const response = await request(
    endpointId,
    `/questions/${encodeURIComponent(conversationId)}/${encodeURIComponent(key ?? '')}/reply`,
    { method: 'POST', body: { answer: null } }
  );
  return response.ok;
};

// ---- Directories ---------------------------------------------------------------------

/** `hasChildren` is false for an empty folder, so the picker can skip drawing a chevron there. */
export type PiDirectory = { name: string; path: string; hasChildren?: boolean };

/** The folder browser for a new conversation: Hearth lists the workspace root's subfolders. */
export const piLoadDirectories = async (
  endpointId: string,
  path?: string,
  scope?: 'computer'
): Promise<{ workspace: string; path: string; directories: PiDirectory[] } | null> => {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (scope) params.set('scope', scope);
  const query = params.size ? `?${params}` : '';
  const response = await request<{ workspace?: string; path?: string; directories?: PiDirectory[] }>(
    endpointId,
    `/directories${query}`
  );
  if (!response.ok) return null;
  return {
    workspace: typeof response.data.workspace === 'string' ? response.data.workspace : '',
    path: typeof response.data.path === 'string' ? response.data.path : '',
    directories: Array.isArray(response.data.directories)
      ? response.data.directories
          .map(asDirectory)
          .filter((entry): entry is PiDirectory => entry !== null)
      : [],
  };
};

export const piCreateDirectory = async (endpointId: string, parent: string, name: string): Promise<string | null> => {
  const response = await request<{ path?: string }>(endpointId, '/directories?scope=computer', { method: 'POST', body: { parent, name } });
  return response.ok && typeof response.data.path === 'string' ? response.data.path : null;
};

const asDirectory = (value: unknown): PiDirectory | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.name !== 'string' || typeof item.path !== 'string') return null;
  return {
    name: item.name,
    path: item.path,
    hasChildren: typeof item.hasChildren === 'boolean' ? item.hasChildren : undefined,
  };
};

// ---- Scheduled tasks ------------------------------------------------------------------

export type PiScheduledTask = {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  schedule: { kind: string; time?: string; weekdays?: number[]; at?: number; timezone?: string };
  conversationId?: number;
  cwd?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  createdAt: number;
  lastRunAt?: number;
  lastSessionId?: number;
  lastStatus?: string;
  lastError?: string;
};

/** Hearth's due-times doc, with the process timezone for display. */
export const piLoadScheduledTasks = async (
  endpointId: string
): Promise<{ tasks: PiScheduledTask[]; timezone?: string } | null> => {
  const response = await request<{ tasks?: PiScheduledTask[]; timezone?: string }>(endpointId, '/scheduled-tasks');
  if (!response.ok) return null;
  const tasks = parseListField<PiScheduledTask>(response.data, 'tasks');
  // An empty tasks list replaces the scheduled view wholesale, so it needs to be an answer.
  if (!tasks) return null;
  return {
    tasks,
    timezone: typeof response.data.timezone === 'string' ? response.data.timezone : undefined,
  };
};

export const piRunScheduledTask = async (
  endpointId: string,
  id: string
): Promise<{ ok: boolean; sessionId?: string; error?: string }> => {
  const response = await request<{ status?: string; sessionId?: number; error?: string }>(
    endpointId,
    `/scheduled-tasks/${encodeURIComponent(id)}/run`,
    { method: 'POST' }
  );
  if (!response.ok) {
    return { ok: false, error: response.data?.error ?? `ember-harness refused (${response.status})` };
  }
  return {
    ok: true,
    sessionId: response.data?.sessionId !== undefined ? String(response.data.sessionId) : undefined,
  };
};

export const piUpdateScheduledTaskModel = async (
  endpointId: string,
  id: string,
  model: { providerID: string; modelID: string; variant?: string }
): Promise<{ ok: boolean; error?: string }> => {
  const response = await request<{ error?: string }>(endpointId, `/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: {
      model: { provider: model.providerID, modelId: model.modelID },
      ...(model.variant ? { thinkingLevel: model.variant } : {}),
    },
  });
  if (!response.ok) return { ok: false, error: response.data?.error };
  return { ok: true };
};

// ---- Auto-accept ----------------------------------------------------------------------

/**
 * Hearth carries each conversation's server-side YOLO flag on the summary, so one
 * `/conversations` read yields the whole per-session policy (`supported: true`). A missing
 * flag reads as off.
 */
export const piLoadAutoAcceptPolicy = async (
  endpointId: string
): Promise<{ supported: boolean; sessions: Record<string, boolean> } | null> => {
  const response = await request<{ conversations?: PiConversationSummary[] }>(endpointId, '/conversations');
  if (!response.ok) return null;
  const conversations = parseConversations(response.data);
  // All-off is a real policy; it must not be produced by a body that isn't a conversation list.
  if (!conversations) return null;
  const sessions: Record<string, boolean> = {};
  conversations.forEach((conversation) => {
    sessions[String(conversation.id)] = conversation.autoAccept === true;
  });
  return { supported: true, sessions };
};

export const piSetAutoAccept = async (
  endpointId: string,
  conversationId: string,
  enabled: boolean
): Promise<{ ok: boolean; status: number }> => {
  const response = await request(endpointId, `/conversations/${encodeURIComponent(conversationId)}/auto-accept`, {
    method: 'PUT',
    body: { enabled },
  });
  return { ok: response.ok, status: response.status };
};

// ---- Providers ------------------------------------------------------------------------
// Hearth owns its provider credentials (`$HEARTH_HOME/auth.json`); `GET /providers` reports
// each provider's id/name and the credential *type* it holds, never the secret. The panel is
// user config, never code — so it's safe for a public repo.

export type PiProviderCredential = 'api_key' | 'oauth';

export type PiProviderInfo = {
  id: string;
  name: string;
  /** The credential Hearth holds for this provider, or null when it has none. */
  credential: PiProviderCredential | null;
  /**
   * Present when Hearth can drive this provider's sign-in itself: the label to put on the button,
   * and whether a flow is already running (so the UI can resume rather than start a second one).
   */
  signIn?: { label: string; pending: boolean } | null;
  custom?: boolean;
};

/** What a sign-in flow has told us so far. Mirrors Hearth's `src/login.ts`. */
export type PiLoginEvent =
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'auth_url'; url: string; instructions?: string }
  /**
   * A browser-callback flow waiting for the reply it could not receive at its loopback address:
   * the person pastes the redirect URL back. `placeholder` carries the address the host expects,
   * which is both the hint and what the answer is checked against.
   */
  | { type: 'question'; message: string; placeholder?: string; options?: Array<{ id: string; label: string }> }
  | { type: 'info'; message: string }
  | { type: 'progress'; message: string };

export type PiLoginState = {
  status: 'pending' | 'complete' | 'failed';
  events: PiLoginEvent[];
  /** Present once `status` is `complete`; Hearth won't return it twice. */
  credential?: unknown;
  error?: string;
};

/**
 * What this client can do with a question a sign-in asks mid-flow.
 *
 * A browser-callback sign-in (Google Antigravity, OpenAI's ChatGPT flow) finishes by sending the
 * browser to a loopback address on the host running Kiln. When that browser is on another machine —
 * Ember driven over remote access, a container, a box whose port is not reachable — the redirect
 * never arrives, and the only way through is for the person to paste the redirect URL back. Ember
 * can show the question and return the answer, so it says so; a plain REST client cannot, and Kiln
 * answers it with a refusal that says which machine to use instead.
 */
export type PiLoginInput = { prompt: { capable: boolean } };

/** The capability Ember always has: it runs in front of the person. */
export const EMBER_LOGIN_INPUT: PiLoginInput = { prompt: { capable: true } };

export type PiProviderCatalog = {
  providers: PiProviderInfo[];
  default?: { provider: string; modelId: string };
};

const providerErrorText = (data: unknown, fallback: string): string => {
  const error = (data as { error?: unknown } | null | undefined)?.error;
  return typeof error === 'string' && error ? error : fallback;
};

const credentialOf = (value: unknown): PiProviderCredential | null =>
  value === 'api_key' || value === 'oauth' ? value : null;

export const piLoadProviders = async (endpointId: string): Promise<PiProviderCatalog | null> => {
  const response = await request<{
    providers?: Array<{ id?: unknown; name?: unknown; credential?: unknown }>;
    default?: { provider: string; modelId: string };
  }>(endpointId, '/providers');
  if (!response.ok) return null;
  const providers = (Array.isArray(response.data.providers) ? response.data.providers : [])
    .filter((entry): entry is { id: string; name?: unknown; credential?: unknown } =>
      typeof entry?.id === 'string' && entry.id.length > 0
    )
    .map((entry) => {
      const signIn = (entry as { signIn?: unknown }).signIn;
      const parsed = signIn && typeof signIn === 'object'
        ? {
            label: typeof (signIn as { label?: unknown }).label === 'string'
              ? String((signIn as { label: string }).label)
              : 'Sign in',
            pending: (signIn as { pending?: unknown }).pending === true,
          }
        : null;
      return {
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
        credential: credentialOf(entry.credential),
        signIn: parsed,
        ...((entry as { custom?: unknown }).custom === true ? { custom: true } : {}),
      };
    });
  return { providers, default: response.data.default };
};

/** Set one provider's API key on the Hearth host; returns a message on failure. */
export const piSetProviderKey = async (
  endpointId: string,
  providerId: string,
  key: string
): Promise<{ ok: boolean; status: number; error?: string }> => {
  const response = await request(endpointId, `/providers/${encodeURIComponent(providerId)}`, {
    method: 'POST',
    body: { type: 'api_key', key },
  });
  return response.ok
    ? { ok: true, status: response.status }
    : { ok: false, status: response.status, error: providerErrorText(response.data, `HTTP ${response.status || 'no reply'}`) };
};

/** Begin (or resume) a provider sign-in on the Hearth host; returns the device code when there is one. */
export const piStartProviderLogin = async (
  endpointId: string,
  providerId: string,
  input: PiLoginInput = EMBER_LOGIN_INPUT
): Promise<{ ok: boolean; state?: PiLoginState; error?: string }> => {
  const response = await request<PiLoginState>(endpointId, `/providers/${encodeURIComponent(providerId)}/login`, {
    method: 'POST',
    body: input,
  });
  return response.ok
    ? { ok: true, state: response.data }
    : { ok: false, error: providerErrorText(response.data, `HTTP ${response.status || 'no reply'}`) };
};

/** Read a sign-in's progress. */
export const piPollProviderLogin = async (
  endpointId: string,
  providerId: string
): Promise<{ ok: boolean; status: number; state?: PiLoginState; error?: string }> => {
  const response = await request<PiLoginState>(endpointId, `/providers/${encodeURIComponent(providerId)}/login`);
  return response.ok
    ? { ok: true, status: response.status, state: response.data }
    : {
        ok: false,
        status: response.status,
        error: providerErrorText(response.data, `HTTP ${response.status || 'no reply'}`),
      };
};

/**
 * Answer the question a sign-in is blocked on.
 *
 * Separate from start and poll because it is the human's own act mid-flow: the flow is parked
 * waiting for it, so there is nothing else to send and no order to get wrong.
 */
export const piAnswerProviderLogin = async (
  endpointId: string,
  providerId: string,
  answer: string
): Promise<{ ok: boolean; error?: string }> => {
  const response = await request(endpointId, `/providers/${encodeURIComponent(providerId)}/login/answer`, {
    method: 'POST',
    body: { answer },
  });
  return response.ok
    ? { ok: true }
    : {
        ok: false,
        error: providerErrorText(
          response.data,
          response.status ? `HTTP ${response.status}` : 'The host did not answer. Check that it is running, then try again.'
        ),
      };
};

/** Abandon a running sign-in. Idempotent. */
export const piCancelProviderLogin = async (
  endpointId: string,
  providerId: string
): Promise<{ ok: boolean }> => {
  const response = await request(endpointId, `/providers/${encodeURIComponent(providerId)}/login`, {
    method: 'DELETE',
  });
  return { ok: response.ok };
};

/** Clear one provider's credential on the Hearth host. */
export const piRemoveProvider = async (
  endpointId: string,
  providerId: string
): Promise<{ ok: boolean; status: number; error?: string }> => {
  const response = await request(endpointId, `/providers/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  });
  return response.ok
    ? { ok: true, status: response.status }
    : { ok: false, status: response.status, error: providerErrorText(response.data, `HTTP ${response.status || 'no reply'}`) };
};



export type PiCustomProvider = { id: string; name: string; baseUrl: string; modelIds: string[]; hasApiKey: boolean; problem?: string };
export type PiCustomProviderInput = { name: string; baseUrl: string; modelIds: string[]; apiKey?: string };
/** Metadata only is read back. Optional secrets travel only in authenticated writes to this Kiln. */
export async function piCustomProviders<T>(endpointId: string, suffix = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await request<T>(endpointId, `/custom-providers${suffix}`, { method, ...(body === undefined ? {} : { body }) });
  if (!response.ok) throw new Error(providerErrorText(response.data, 'This Kiln did not answer. Retry, or update Kiln if custom providers are unavailable.'));
  return response.data;
}
