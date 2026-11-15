import { createQuestion } from '../src/questions';
import { SessionTool, Sessions, SessionsDoc } from '../src/sessions';
import { MetaDoc } from '../src/meta';
import type { ConversationId, ToolExecutionApi } from '@earendil-works/pi-durable';
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { createRegistry, Harness, defineExtension, defineTool, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { hearthConfig } from "../src/config";
import { FileCredentialStore } from "../src/credentials";
import { startHearthServer, type HearthServer } from "../src/server";

/**
 * Submission actions: an abort belongs to the conversation in its path, and a retried `requestId`
 * either returns the submission that placed the message or places it — never a settled no-op that
 * reads as "sent".
 */
const context = BACKGROUND_CONTEXT;
const TOKEN = "test-token-0123456789abcdef0123456789abcdef";

/** A tool slow enough that a conversation is genuinely busy while a queue is being built. */
const Slow = defineExtension({
  name: "slow",
  tools: [
    defineTool({
      name: "slowecho",
      description: "Echo after a pause",
      parameters: obj({ text: str() }),
      replay: "safe",
      execute: async ({ text }) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { output: [{ type: "text", text: `echo: ${text}` }] };
      },
    }),
  ],
});

let home: string;
let harness: HarnessType;
let server: HearthServer;
let faux: ReturnType<typeof fauxProvider>;
let afterComplete: (() => Promise<void>) | undefined;

const api = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });

const body = async (response: Response): Promise<any> => response.json();

const createConversation = async (title: string): Promise<number> => {
  const response = await api("/conversations", {
    method: "POST",
    body: JSON.stringify({ title, model: { provider: "faux", modelId: "faux-1" } }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id?: unknown }).id as number;
};

const submit = (conversation: number, draft: Record<string, unknown>): Promise<Response> =>
  api(`/conversations/${conversation}/submit`, { method: "POST", body: JSON.stringify(draft) });

/** Hold a conversation in a run so the next inputs queue behind it. */
const holdBusy = async (conversation: number): Promise<void> => {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("slowecho", { text: "busy" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("free")]),
  ]);
  const response = await submit(conversation, { type: "input", content: "hold the turn" });
  expect(response.status).toBe(201);
};

/** The conversation's inbox as the wire reports it, bounded to what is queued. */
const queuedText = async (conversation: number): Promise<string[]> => {
  const queue = await body(await api("/queue"));
  const session = queue.sessions.find((each: any) => Number(each.sessionId) === conversation);
  return (session?.items ?? []).map((item: any) => item.text);
};

/** The text of one entry's first message, when it is a user turn. */
const userTextOf = (entry: any): string | undefined => {
  const message = entry?.model?.[0];
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.find((part: any) => part?.type === "text")?.text;
  return undefined;
};

/** How many `user` entries of one exact text the conversation holds. */
const userEntries = async (conversation: number, text: string): Promise<number> =>
  (await body(await api(`/conversations/${conversation}/entries?limit=100`))).entries.filter(
    (entry: any) => userTextOf(entry) === text
  ).length;

const settle = async (conversation: number): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = await body(await api("/conversations"));
    if (list.conversations.find((each: any) => each.id === conversation)?.busy === false) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "hearth-actions-"));
  faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("Ready.")])]);
  // Inferred: `createModels()` returns the concrete type, which carries `setProvider`;
  // the exported `Models` interface is only the read side.
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Slow);
  registry.install({ ...Sessions, tools: [{ ...SessionTool, execute: async (args: Parameters<typeof SessionTool.execute>[0], api: ToolExecutionApi, ctx: typeof context) => {
    const result = await SessionTool.execute(args, api, ctx);
    if (args.action === 'complete' && result.control?.terminate) await afterComplete?.();
    return result;
  } }] });
  const storage = await openNodeSqliteStorage(join(home, "hearth.sqlite"));
  harness = await Harness.open(
    storage,
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  server = startHearthServer({
    config: hearthConfig({ home, port: 0, workspace: home }),
    token: TOKEN,
    storage,
    harness,
    models,
    defaultAgent: { model: { provider: "faux", modelId: "faux-1" } },
    store: new FileCredentialStore(join(home, "auth.json")),
    version: "9.9.9",
    build: "testsha",
  });
});

afterAll(async () => {
  await server.close();
  await harness.close(context);
  // Windows holds the sqlite handle for a moment; a leftover temp dir is not a failure.
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

describe("submission actions", () => {
  test("submission receipts expose canonical identities only within their conversation", async () => {
    const owner = await createConversation("receipt owner");
    const other = await createConversation("receipt other");
    await holdBusy(owner);
    const queued = await body(await submit(owner, { type: "input", content: "linked annotation", requestId: "annotation-receipt" }));
    const path = "/conversations/" + owner + "/submissions/" + queued.submissionId;
    const receipt = await api(path);
    expect(receipt.status).toBe(200);
    expect(await body(receipt)).toMatchObject({ submissionId: queued.submissionId, status: "queued" });
    expect((await api("/conversations/" + other + "/submissions/" + queued.submissionId)).status).toBe(404);
    const unauthenticated = await fetch(server.url + path);
    expect(unauthenticated.status).toBe(401);
    await settle(owner);
    const placed = await body(await api(path));
    expect(["placed", "done", "unanswered"]).toContain(placed.status);
    expect(typeof placed.entry).toBe("number");
  });

  test("receipt correlation survives stop re-parking without matching duplicate text", async () => {
    const owner = await createConversation("receipt stop");
    await holdBusy(owner);
    const first = await body(await submit(owner, { type: "input", content: "same annotation" }));
    const second = await body(await submit(owner, { type: "input", content: "same annotation" }));
    await api("/conversations/" + owner + "/abort", { method: "POST" });
    await settle(owner);
    const receipts = await Promise.all([first, second].map(async (original) => body(await api("/conversations/" + owner + "/submissions/" + original.submissionId))));
    expect(receipts[0].submissionId).not.toBe(receipts[1].submissionId);
    for (const [index, receipt] of receipts.entries()) {
      expect(receipt.status).toBe("queued");
      expect(receipt.submissionId).not.toBe([first, second][index].submissionId);
    }
  });

  test("reordering preserves explicit submission lineage for repeated annotations", async () => {
    const owner = await createConversation("receipt reorder");
    await holdBusy(owner);
    const first = await body(await submit(owner, { type: "input", content: "same annotation" }));
    const second = await body(await submit(owner, { type: "input", content: "same annotation" }));
    const reordered = await api("/conversations/" + owner + "/queue/order", { method: "PUT", body: JSON.stringify({ itemIds: [String(second.submissionId), String(first.submissionId)] }) });
    expect(reordered.status).toBe(200);
    const mutation = await body(reordered);
    const firstReceipt = await body(await api("/conversations/" + owner + "/submissions/" + first.submissionId));
    const secondReceipt = await body(await api("/conversations/" + owner + "/submissions/" + second.submissionId));
    expect(String(firstReceipt.submissionId)).toBe(mutation.session.items[1].id);
    expect(String(secondReceipt.submissionId)).toBe(mutation.session.items[0].id);
    expect(mutation.replacements).toEqual({ [String(first.submissionId)]: String(firstReceipt.submissionId), [String(second.submissionId)]: String(secondReceipt.submissionId) });
    await api("/conversations/" + owner + "/abort", { method: "POST" });
    await settle(owner);
  });

  test("an abort is scoped to the conversation in the path", async () => {
    const owner = await createConversation("abort owner");
    const other = await createConversation("abort other");

    await holdBusy(owner);
    const mine = await body(await submit(owner, { type: "input", content: "queued in the owner" }));
    expect(mine.status).toBe("queued");
    expect(await queuedText(owner)).toEqual(["queued in the owner"]);

    // A crossed or stale id must not withdraw the owner's message: 404, and the inbox is intact.
    const crossed = await api(`/conversations/${other}/submissions/${mine.submissionId}/abort`, { method: "POST" });
    expect(crossed.status).toBe(404);
    const crossedBody = (await crossed.json()) as { error?: string };
    expect(typeof crossedBody.error).toBe("string");
    expect(crossedBody.error).toContain(String(mine.submissionId));
    expect(await queuedText(owner)).toEqual(["queued in the owner"]);

    // The owner's own abort still works, and says what it did.
    const own = await api(`/conversations/${owner}/submissions/${mine.submissionId}/abort`, { method: "POST" });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ ok: true, result: "aborted" });
    expect(await queuedText(owner)).toEqual([]);

    await api(`/conversations/${owner}/abort`, { method: "POST" });
    await settle(owner);
  });

  test("the answer reports the full status set, with the reason when unanswered", async () => {
    const conversation = await createConversation("statuses");

    // `write` settles `done` and carries the entry it appended.
    const write = await body(
      await submit(conversation, { type: "write", entry: { kind: "test.note", data: { text: "a note" } } })
    );
    expect(write.status).toBe("done");
    expect(write.mode).toBe("write");
    expect(typeof write.entry).toBe("number");

    // An input on an idle conversation is placed and names its entry.
    faux.setResponses([fauxAssistantMessage([fauxText("answered")])]);
    const placed = await body(await submit(conversation, { type: "input", content: "hello there" }));
    expect(placed.status).toBe("placed");
    expect(placed.mode).toBe("followUp");
    expect(typeof placed.entry).toBe("number");
    expect(placed.reason).toBeUndefined();
    await settle(conversation);

    // A queued input behind a running turn, withdrawn before it runs, settles `unanswered` with
    // the reason — and a status a client can act on instead of guessing.
    await holdBusy(conversation);
    const queued = await body(await submit(conversation, { type: "input", content: "queued then stopped" }));
    expect(queued.status).toBe("queued");
    expect(queued.mode).toBe("followUp");
    await api(`/conversations/${conversation}/submissions/${queued.submissionId}/abort`, { method: "POST" });
    const settled = await body(await api(`/conversations/${conversation}/submissions/${queued.submissionId}/abort`, { method: "POST" }));
    // A second withdrawal is not a success pretending to be one.
    expect(settled.ok).toBe(false);
    expect(settled.result).toBe("settled");
    await api(`/conversations/${conversation}/abort`, { method: "POST" });
    await settle(conversation);
  });

  test("a retried requestId after an unanswered submission places the message", async () => {
    const conversation = await createConversation("retry unanswered");
    await holdBusy(conversation);
    const first = await body(
      await submit(conversation, { type: "input", content: "the message that must arrive", requestId: "retry-a" })
    );
    expect(first.status).toBe("queued");
    // Stop it before it reaches the transcript: the client's retry is all the user has left.
    await api(`/conversations/${conversation}/submissions/${first.submissionId}/abort`, { method: "POST" });
    expect(await userEntries(conversation, "the message that must arrive")).toBe(0);
    await api(`/conversations/${conversation}/abort`, { method: "POST" });
    await settle(conversation);

    // The retry carries the same requestId and the same message.
    faux.setResponses([fauxAssistantMessage([fauxText("answered the retry")])]);
    const again = await body(
      await submit(conversation, { type: "input", content: "the message that must arrive", requestId: "retry-a" })
    );
    expect(again.submissionId).not.toBe(first.submissionId);
    expect(["placed", "queued"]).toContain(again.status);
    await settle(conversation);
    expect(await userEntries(conversation, "the message that must arrive")).toBe(1);

    // And a third retry of the same id is a no-op: the newest attempt reached the transcript.
    const third = await body(
      await submit(conversation, { type: "input", content: "the message that must arrive", requestId: "retry-a" })
    );
    expect(third.submissionId).toBe(again.submissionId);
    await settle(conversation);
    expect(await userEntries(conversation, "the message that must arrive")).toBe(1);
  });

  test("a retried requestId after a placed submission places nothing extra", async () => {
    const conversation = await createConversation("retry placed");
    faux.setResponses([
      fauxAssistantMessage([fauxText("first answer")]),
      fauxAssistantMessage([fauxText("second answer")]),
    ]);
    const first = await body(await submit(conversation, { type: "input", content: "said once", requestId: "retry-b" }));
    expect(first.status).toBe("placed");
    await settle(conversation);

    const retry = await body(await submit(conversation, { type: "input", content: "said once", requestId: "retry-b" }));
    expect(retry.submissionId).toBe(first.submissionId);
    expect(retry.entry).toBe(first.entry);
    await settle(conversation);
    expect(await userEntries(conversation, "said once")).toBe(1);
  });
  test("explicit task summary exposes Done and human correction reopens atomically without retry reassignment", async () => {
    const owner = await createConversation("Task coordinator") as ConversationId;
    const worker = await createConversation("Worker renamed title") as ConversationId;
    await harness.commit(async tx => {
      Object.assign(await tx.doc(MetaDoc, worker), { kind: 'worker', creatorId: owner, lead: { conversationId: owner, host: 'local' } });
      (await tx.doc(SessionsDoc, owner)).items.work = { kind: 'worker', conversationId: worker, creatorId: owner,
        title: 'Stable outcome title', state: 'running', spawnedAt: 100, generation: 1, briefRequestId: 'brief', delivery: 'thread', taskLifecycle: 'explicit' };
    }, context);
    const questionApi = { taskId: 'wire-async-question', conversationId: worker, commit: harness.commit.bind(harness) } as unknown as ToolExecutionApi;
    await createQuestion(questionApi, { question: 'Optional follow-up decision?' }, context);
    const pending = (await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker);
    expect(pending.task.status).toBe('waiting'); expect(pending.needsInput).toBe(false);
    const toolApi = { taskId: 'wire-complete', conversationId: worker, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) } as unknown as ToolExecutionApi;
    expect((await SessionTool.execute({ action: 'complete', task: String(worker) + ':100', summary: 'Implemented', evidence: 'tests green', remaining: 'none' }, toolApi, context)).control?.terminate).toBe(true);
    const done = (await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker);
    expect(done.task).toMatchObject({ id: String(worker) + ':100', title: 'Stable outcome title', status: 'done', completion: { summary: 'Implemented' } });
    faux.setResponses([fauxAssistantMessage([fauxText('Correction processed')])]);
    const response = await submit(worker, { type: 'input', content: 'Correction: test one more case', requestId: 'human-correction' });
    expect(response.status).toBe(201); await settle(worker);
    const reopened = (await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker);
    expect(reopened.task.status).toBe('waiting'); expect(reopened.task.completion).toBeUndefined();
    expect(reopened.task.id).not.toBe(done.task.id); expect(reopened.task.title).toBe(done.task.title);
    const retry = await submit(worker, { type: 'input', content: 'Correction: test one more case', requestId: 'human-correction' });
    expect(retry.status).toBe(201);
    expect(((await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker)).task.id).toBe(reopened.task.id);
    expect(await userEntries(worker, 'Correction: test one more case')).toBe(1);
    await harness.commit(async tx => { (await tx.doc(SessionsDoc, owner)).items.work.state = 'failed'; }, context);
    expect((await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker).task.status).toBe('failed');
    await harness.commit(async tx => { (await tx.doc(SessionsDoc, owner)).items.work.state = 'stopped'; }, context);
    expect((await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker).task.status).toBe('stopped');

  });

  test.each(['blocked', 'incomplete', 'handoff-needed'] as const)('wire exposes %s as unfinished and explicit input starts a new version once', async outcome => {
    const owner = await createConversation('Outcome coordinator') as ConversationId;
    const worker = await createConversation('Paused worker') as ConversationId;
    await harness.commit(async tx => {
      Object.assign(await tx.doc(MetaDoc, worker), { kind: 'worker', creatorId: owner, lead: { conversationId: owner, host: 'local' } });
      (await tx.doc(SessionsDoc, owner)).items.work = { kind: 'worker', conversationId: worker, creatorId: owner,
        title: 'Finish the reviewed feature', state: 'running', spawnedAt: 100, generation: 1, briefRequestId: 'brief', delivery: 'thread', taskLifecycle: 'explicit' };
    }, context);
    const toolApi = { taskId: 'wire-report-' + outcome, conversationId: worker, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) } as unknown as ToolExecutionApi;
    expect((await SessionTool.execute({ action: 'report', outcome, task: String(worker) + ':100', summary: 'Not delivered', evidence: 'A regression still fails', remaining: 'Review and fix the failing case' }, toolApi, context)).control?.terminate).toBe(true);
    const summary = async () => (await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker);
    const paused = await summary();
    expect(paused.task).toMatchObject({ status: outcome, completion: { outcome, summary: 'Not delivered' } });
    expect(paused.task.status).not.toBe('done');
    faux.setResponses([fauxAssistantMessage([fauxText('Explicit direction received')])]);
    const draft = { type: 'input', content: 'Fix the guard before continuing', requestId: 'reopen-' + outcome };
    expect((await submit(worker, draft)).status).toBe(201);
    await settle(worker);
    const reopened = await summary();
    expect(reopened.task.status).toBe('waiting');
    expect(reopened.task.completion).toBeUndefined();
    expect(reopened.task.id).not.toBe(paused.task.id);
    await submit(worker, draft);
    expect((await summary()).task.id).toBe(reopened.task.id);
    expect(await userEntries(worker, draft.content)).toBe(1);
  });

  test.each(['failed', 'stopped'] as const)('authenticated human correction reopens %s task and can complete once without retry reassignment', async terminal => {
    const owner = await createConversation('Terminal task coordinator') as ConversationId;
    const worker = await createConversation('Terminal task worker') as ConversationId;
    await harness.commit(async tx => {
      Object.assign(await tx.doc(MetaDoc, worker), { kind: 'worker', creatorId: owner, lead: { conversationId: owner, host: 'local' },
        ...(terminal === 'stopped' ? { stoppedAt: Date.now() } : {}) });
      (await tx.doc(SessionsDoc, owner)).items.work = { kind: 'worker', creatorId: owner, conversationId: worker, title: 'Recover terminal task',
        state: terminal, spawnedAt: 100, generation: 1, briefRequestId: 'terminal-brief', delivery: 'thread', taskLifecycle: 'explicit',
        report: { status: terminal === 'failed' ? 'failed' : 'aborted', text: 'Earlier terminal outcome', at: 101, requestId: 'earlier-terminal-result' } };
    }, context);
    const summary = async () => (await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker);
    expect((await summary()).task.status).toBe(terminal);
    faux.setResponses([async () => {
      const current = (await harness.snapshot(SessionsDoc, owner, context))!.items.work;
      return fauxAssistantMessage([fauxToolCall('session', { action: 'complete', task: String(worker) + ':' + current.taskAt,
        summary: 'Recovered task completed', evidence: 'Authenticated correction and complete tool', remaining: 'none' })], { stopReason: 'toolUse' });
    }]);
    const draft = { type: 'input', content: 'Please recover this task with this correction', requestId: 'recover-' + terminal };
    const admitted = await body(await submit(worker, draft));
    expect(['placed', 'done']).toContain(admitted.status);
    await settle(worker);
    const done = await summary();
    expect(done.task.status).toBe('done'); expect(done.task.id).not.toBe(String(worker) + ':100');
    expect(done.task.completion.summary).toBe('Recovered task completed');
    expect((await harness.snapshot(MetaDoc, worker, context))?.stoppedAt).toBeUndefined();
    const retried = await body(await submit(worker, draft));
    expect(retried.submissionId).toBe(admitted.submissionId);
    expect((await summary()).task.id).toBe(done.task.id); expect((await summary()).task.status).toBe('done');
    expect(await userEntries(worker, draft.content)).toBe(1);
    const entries = await body(await api('/conversations/' + worker + '/entries?limit=100'));
    expect(entries.entries.filter((e: any) => e.kind === 'hearth.task-completion')).toHaveLength(1);
  });

  test("HTTP correction after complete commit but before tool return survives termination and reopens once", async () => {
    const owner = await createConversation('Race coordinator') as ConversationId;
    const worker = await createConversation('Race worker') as ConversationId;
    await harness.commit(async tx => {
      Object.assign(await tx.doc(MetaDoc, worker), { kind: 'worker', creatorId: owner, lead: { conversationId: owner, host: 'local' } });
      (await tx.doc(SessionsDoc, owner)).items.work = { kind: 'worker', creatorId: owner, conversationId: worker, title: 'Preserve corrections',
        state: 'running', spawnedAt: 100, generation: 1, briefRequestId: 'race-brief', delivery: 'thread', taskLifecycle: 'explicit' };
    }, context);
    let persisted!: () => void; const saved = new Promise<void>(resolve => { persisted = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    afterComplete = async () => { persisted(); await gate; };
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('session', { action: 'complete', task: String(worker) + ':100', summary: 'Original done', evidence: 'Original evidence', remaining: 'none' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxText('Late correction processed')]),
      ]);
      expect((await submit(worker, { type: 'input', content: 'Finish original' })).status).toBe(201);
      await saved;
      const done = (await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker);
      expect(done.task.status).toBe('done'); expect(done.busy).toBe(true);
      const correction = await body(await submit(worker, { type: 'input', content: 'Late correction', whenBusy: 'followUp', requestId: 'post-complete-correction' }));
      expect(correction.status).toBe('queued');
      const reopened = (await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker);
      expect(reopened.task.id).not.toBe(done.task.id); expect(reopened.task.status).not.toBe('done');
      release(); await settle(worker);
      expect(await userEntries(worker, 'Late correction')).toBe(1);
      const final = (await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker);
      expect(final.task.status).toBe('waiting'); expect(final.task.id).toBe(reopened.task.id);
      const entries = await body(await api('/conversations/' + worker + '/entries?limit=100'));
      expect(JSON.stringify(entries)).toContain('Late correction processed');
      expect(entries.entries.filter((e: any) => e.kind === 'hearth.task-completion')).toHaveLength(1);
    } finally { afterComplete = undefined; release(); }
  });

  test('parallel command tool finishes normally when a co-round complete saves Done', async () => {
    const owner = await createConversation('Command coordinator') as ConversationId;
    const worker = await createConversation('Command worker') as ConversationId;
    await harness.commit(async tx => {
      Object.assign(await tx.doc(MetaDoc, worker), { kind: 'worker', creatorId: owner, lead: { conversationId: owner, host: 'local' } });
      (await tx.doc(SessionsDoc, owner)).items.work = { kind: 'worker', creatorId: owner, conversationId: worker, title: 'Retain commands',
        state: 'running', spawnedAt: 100, generation: 1, briefRequestId: 'command-brief', delivery: 'thread', taskLifecycle: 'explicit' };
    }, context);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('slowecho', { text: 'command must finish' }),
        fauxToolCall('session', { action: 'complete', task: String(worker) + ':100', summary: 'Saved', evidence: 'command still finishing', remaining: 'Wait for command output' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Command completed normally')]),
    ]);
    expect((await submit(worker, { type: 'input', content: 'Run command then finish' })).status).toBe(201);
    await settle(worker);
    const entries = await body(await api('/conversations/' + worker + '/entries?limit=100'));
    expect(JSON.stringify(entries)).toContain('echo: command must finish');
    expect(JSON.stringify(entries)).toContain('Command completed normally');
    expect((await body(await api('/conversations'))).conversations.find((c: any) => c.id === worker).task.status).toBe('done');
  });

});
