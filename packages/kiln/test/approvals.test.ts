import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type ConversationId } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { registerAgent } from "../src/agents";
import {
  Approvals,
  ApprovalsDoc,
  AutoAcceptDoc,
  clearPendingApprovals,
  gateTool,
  pendingApprovals,
  previewPermission,
  replyApproval,
  requiresScheduleApproval,
  setAutoAccept,
} from "../src/approvals";
import { buildMcpTools, mcpNamespaces, mcpSection } from "../src/mcp";
import { hearthRegistry } from "../src/registry";
import { ScheduleTool } from "../src/schedule";
import { listScheduledTasks } from "../src/scheduler";

const context = BACKGROUND_CONTEXT;

const openHarness = (faux: ReturnType<typeof fauxProvider>): Promise<Harness> => {
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Approvals);
  return Harness.open(new MemoryStorage(), { models, registry }, context);
};

const toolCall = (name: string, args: Record<string, any>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

describe("approvals gate", () => {
  test("a tool call parks, then proceeds once replied", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      toolCall("bash", { command: "echo parked" }),
      fauxAssistantMessage([fauxText("Done after approval.")]),
    ]);
    const harness = await openHarness(faux);
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const submission = await root.submit({ type: "input", content: "run it" }, context);

    // The run is parked: a pending approval exists and the submission is not settled.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const pending = await pendingApprovals(harness, [root.id]);
    expect(pending).toHaveLength(1);
    expect(pending[0].tool).toBe("bash");
    expect(pending[0].arguments.command).toBe("echo parked");

    expect(await replyApproval(harness, root.id, pending[0].key, "once")).toBe(true);
    const settled = await submission.wait(context);
    expect(settled.status).toBe("done");
    const kinds = (await root.entries({}, 20, undefined, context)).items.map((entry) => entry.kind);
    expect(kinds).toContain("pi.tool-result");
    await harness.close(context);
  });

  test("a rejected approval blocks the call and the run still answers", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      toolCall("bash", { command: "echo nope" }),
      fauxAssistantMessage([fauxText("Could not run it.")]),
    ]);
    const harness = await openHarness(faux);
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const submission = await root.submit({ type: "input", content: "run it" }, context);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const pending = await pendingApprovals(harness, [root.id]);
    expect(pending).toHaveLength(1);
    await replyApproval(harness, root.id, pending[0].key, "reject");
    const settled = await submission.wait(context);
    expect(settled.status).toBe("done");
    const results = (await root.entries({}, 20, undefined, context)).items.filter(
      (entry) => entry.kind === "pi.tool-result"
    );
    expect(results).toHaveLength(1);
    await harness.close(context);
  });

  test('"always" turns on auto-accept for the conversation, so every later tool skips parking', async () => {
    const faux = fauxProvider();
    faux.setResponses([
      toolCall("bash", { command: "echo one" }),
      fauxAssistantMessage([fauxText("one done")]),
      toolCall("edit", { path: "notes.txt", edits: [{ oldText: "a", newText: "b" }] }),
      fauxAssistantMessage([fauxText("edited")]),
    ]);
    const harness = await openHarness(faux);
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const first = await root.submit({ type: "input", content: "run one" }, context);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const pending = await pendingApprovals(harness, [root.id]);
    expect(pending).toHaveLength(1);
    await replyApproval(harness, root.id, pending[0].key, "always");
    await first.wait(context);

    // A *different* tool now also runs without parking: "always" enabled auto-accept.
    const second = await root.submit({ type: "input", content: "edit it" }, context);
    const settled = await second.wait(context);
    expect(settled.status).toBe("done");
    expect(await pendingApprovals(harness, [root.id])).toHaveLength(0);
    await harness.close(context);
  });

  test("enabling auto-accept releases an already-parked approval", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      toolCall("bash", { command: "echo yolo" }),
      fauxAssistantMessage([fauxText("Ran with YOLO.")]),
    ]);
    const harness = await openHarness(faux);
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const submission = await root.submit({ type: "input", content: "run it" }, context);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await pendingApprovals(harness, [root.id])).toHaveLength(1);

    // YOLO turned on *while the request is already parked* must release it (the gate used to read
    // auto-accept once, before parking, and wait forever).
    await setAutoAccept(harness, root.id, true);
    const settled = await submission.wait(context);
    expect(settled.status).toBe("done");
    const results = (await root.entries({}, 20, undefined, context)).items.filter(
      (entry) => entry.kind === "pi.tool-result"
    );
    expect(results).toHaveLength(1);
    expect(await pendingApprovals(harness, [root.id])).toHaveLength(0);
    await harness.close(context);
  }, 10_000);

  test("aborting a run parked on an approval resolves and clears the prompt", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      toolCall("bash", { command: "echo parked" }),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    const harness = await openHarness(faux);
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    await root.submit({ type: "input", content: "run it" }, context);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await pendingApprovals(harness, [root.id])).toHaveLength(1);

    // The parked gate must observe the abort so the conversation can go idle; it used to deadlock.
    await Promise.race([
      root.abort(context),
      new Promise((_, reject) => setTimeout(() => reject(new Error("abort deadlocked on a parked approval")), 3_000)),
    ]);
    await clearPendingApprovals(harness, root.id);
    expect(await pendingApprovals(harness, [root.id])).toHaveLength(0);
    await harness.close(context);
  });
});

const waitForPending = async (harness: Harness, id: ConversationId) => {
  for (let i = 0; i < 150; i += 1) {
    const pending = await pendingApprovals(harness, [id]);
    if (pending.length > 0) return pending;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for pending approval");
};

describe("S1 privilege-escalation gates (schedule, agents, MCP, codemode)", () => {
  test("schedule: list is ungated; non-YOLO create/update/remove park in ApprovalsDoc without writing SchedulerDoc; YOLO runs immediately", async () => {
    const home = await mkdtemp(join(tmpdir(), "hearth-approvals-schedule-"));
    const faux = fauxProvider();
    faux.setResponses([
      // 1. list: ungated
      toolCall("schedule", { action: "list" }),
      fauxAssistantMessage([fauxText("Listed empty schedule.")]),
      // 2. create: rejected -> SchedulerDoc stays empty
      toolCall("schedule", {
        action: "create",
        name: "Evil cron",
        prompt: "rm -rf /",
        schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
      }),
      fauxAssistantMessage([fauxText("Rejected.")]),
      // 3. create: approved -> writes SchedulerDoc
      toolCall("schedule", {
        action: "create",
        name: "Morning check",
        prompt: "Check health",
        schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
        cwd: home,
      }),
      fauxAssistantMessage([fauxText("Created.")]),
      // 4. update: parks until approved
      toolCall("schedule", {
        action: "update",
        task: "Morning check",
        prompt: "Check health and metrics",
        enabled: false,
      }),
      fauxAssistantMessage([fauxText("Updated.")]),
      // 5. remove: parks until approved
      toolCall("schedule", {
        action: "remove",
        task: "Morning check",
      }),
      fauxAssistantMessage([fauxText("Removed.")]),
      // 6. YOLO create: runs immediately without parking
      toolCall("schedule", {
        action: "create",
        name: "YOLO check",
        prompt: "Run unattended",
        schedule: { kind: "daily", time: "10:00", timezone: "UTC" },
      }),
      fauxAssistantMessage([fauxText("YOLO created.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(new MemoryStorage(), { models, registry: hearthRegistry(home) }, context);
    try {
      const conv = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

      // 1. `list` runs without parking an approval.
      const listSub = await conv.submit({ type: "input", content: "list schedules" }, context);
      expect((await listSub.wait(context)).status).toBe("done");
      expect(await pendingApprovals(harness, [conv.id])).toHaveLength(0);

      // 2. Non-YOLO `create` parks and does NOT write SchedulerDoc when pending or rejected.
      const rejectedCreate = await conv.submit({ type: "input", content: "create evil" }, context);
      let [pending] = await waitForPending(harness, conv.id);
      expect(pending.tool).toBe("schedule");
      expect(pending.arguments).toMatchObject({ action: "create", name: "Evil cron" });
      expect((await listScheduledTasks(harness, context)).tasks).toHaveLength(0);
      // PermissionRulesDoc preview fails closed cleanly for non-bash tools.
      expect((await previewPermission(harness, conv.id, pending.key, undefined)).supported).toBe(false);
      await replyApproval(harness, conv.id, pending.key, "reject");
      await rejectedCreate.wait(context);
      expect((await listScheduledTasks(harness, context)).tasks).toHaveLength(0);

      // 3. Non-YOLO `create` writes SchedulerDoc only AFTER approval.
      const approvedCreate = await conv.submit({ type: "input", content: "create morning" }, context);
      [pending] = await waitForPending(harness, conv.id);
      expect((await listScheduledTasks(harness, context)).tasks).toHaveLength(0);
      await replyApproval(harness, conv.id, pending.key, "once");
      await approvedCreate.wait(context);
      const afterCreate = (await listScheduledTasks(harness, context)).tasks;
      expect(afterCreate).toHaveLength(1);
      expect(afterCreate[0]).toMatchObject({ name: "Morning check", prompt: "Check health", enabled: true });

      // 4. Non-YOLO `update` parks without mutating SchedulerDoc until approved.
      const approvedUpdate = await conv.submit({ type: "input", content: "update morning" }, context);
      [pending] = await waitForPending(harness, conv.id);
      expect(pending.tool).toBe("schedule");
      expect(pending.arguments).toMatchObject({ action: "update", task: "Morning check" });
      expect((await listScheduledTasks(harness, context)).tasks[0].prompt).toBe("Check health");
      expect((await listScheduledTasks(harness, context)).tasks[0].enabled).toBe(true);
      await replyApproval(harness, conv.id, pending.key, "once");
      await approvedUpdate.wait(context);
      expect((await listScheduledTasks(harness, context)).tasks[0]).toMatchObject({
        prompt: "Check health and metrics",
        enabled: false,
      });

      // 5. Non-YOLO `remove` (delete) parks without deleting from SchedulerDoc until approved.
      const approvedRemove = await conv.submit({ type: "input", content: "remove morning" }, context);
      [pending] = await waitForPending(harness, conv.id);
      expect(pending.tool).toBe("schedule");
      expect(pending.arguments).toMatchObject({ action: "remove", task: "Morning check" });
      expect((await listScheduledTasks(harness, context)).tasks).toHaveLength(1);
      await replyApproval(harness, conv.id, pending.key, "once");
      await approvedRemove.wait(context);
      expect((await listScheduledTasks(harness, context)).tasks).toHaveLength(0);

      // Direct gate check: any non-`list` action string (including `"delete"`) fails closed behind the gate,
      // and `AutoAcceptDoc.allowed` permits `"schedule"` when explicitly configured.
      expect(requiresScheduleApproval({ action: "delete", task: "task_1" })).toBe(true);
      expect(requiresScheduleApproval({ action: "list" })).toBe(false);
      const gatedSchedule = gateTool(ScheduleTool, requiresScheduleApproval);
      const directController = new AbortController();
      const directTaskPromise = gatedSchedule.execute(
        { action: "delete", task: "task_1" } as never,
        {
          taskId: 9999 as never,
          callId: "direct-delete",
          conversationId: conv.id,
          now: () => Date.now(),
          snapshot: (token: any, first: any, second?: any) =>
            second === undefined ? harness.snapshot(token, first) : harness.snapshot(token, first, second),
          commit: (change: any, ctx: any) => harness.commit(change, ctx),
        } as never,
        { ...context, abortSignal: directController.signal }
      );
      for (let i = 0; i < 50; i += 1) {
        const doc = await harness.snapshot(ApprovalsDoc, conv.id, context);
        if (doc?.items["9999"]?.status === "pending") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect((await harness.snapshot(ApprovalsDoc, conv.id, context))?.items["9999"]?.status).toBe("pending");
      directController.abort();
      expect((await directTaskPromise).isError).toBe(true);
      await clearPendingApprovals(harness, conv.id, context);

      // 6. YOLO conversation creates a schedule immediately without parking.
      await setAutoAccept(harness, conv.id, true, context);
      const yoloCreate = await conv.submit({ type: "input", content: "yolo create" }, context);
      expect((await yoloCreate.wait(context)).status).toBe("done");
      expect(await pendingApprovals(harness, [conv.id])).toHaveLength(0);
      expect((await listScheduledTasks(harness, context)).tasks.map((t) => t.name)).toEqual(["YOLO check"]);

      // `AutoAcceptDoc.allowed` also permits a named tool when `enabled` is false.
      await harness.commit(async (tx) => {
        const auto = await tx.doc(AutoAcceptDoc, conv.id);
        auto.enabled = false;
        auto.allowed = ["schedule"];
      }, context);
      const allowedList = await gatedSchedule.execute(
        { action: "remove", task: "YOLO check" } as never,
        {
          taskId: 10000 as never,
          callId: "allowed-remove",
          conversationId: conv.id,
          now: () => Date.now(),
          snapshot: (token: any, first: any, second?: any) =>
            second === undefined ? harness.snapshot(token, first) : harness.snapshot(token, first, second),
          commit: (change: any, ctx: any) => harness.commit(change, ctx),
        } as never,
        context
      );
      expect(allowedList.isError).toBeUndefined();
      expect((await listScheduledTasks(harness, context)).tasks).toHaveLength(0);
    } finally {
      await harness.close(context);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 30_000);

  test("agents: directory runs without approval; non-YOLO send parks in ApprovalsDoc until approved", async () => {
    const home = await mkdtemp(join(tmpdir(), "hearth-approvals-agents-"));
    const faux = fauxProvider();
    faux.setResponses([
      // 1. directory: ungated
      toolCall("agents", { action: "directory" }),
      fauxAssistantMessage([fauxText("Saw Builder in directory.")]),
      // 2. send: rejected -> target receives nothing
      toolCall("agents", { action: "send", name: "Builder", message: "UNAPPROVED_INSTRUCTION" }),
      fauxAssistantMessage([fauxText("Send rejected.")]),
      // 3. send: approved -> target receives message
      toolCall("agents", { action: "send", name: "Builder", message: "APPROVED_INSTRUCTION" }),
      fauxAssistantMessage([fauxText("Sent after approval.")]),
      fauxAssistantMessage([fauxText("Builder acknowledged.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(new MemoryStorage(), { models, registry: hearthRegistry(home) }, context);
    try {
      const sender = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
        context
      );
      const builder = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
        context
      );
      // Even when the peer is YOLO, the non-YOLO sender cannot message it without approval.
      await setAutoAccept(harness, builder.id, true, context);
      await harness.commit(
        (tx) =>
          registerAgent(tx, "Builder", {
            conversationId: builder.id as number,
            host: "local",
            description: "YOLO peer",
            pinned: true,
            createdAt: 1,
            updatedAt: 1,
          }),
        context
      );

      const builderHandle = (await harness.conversation(builder.id, context))!;
      const builderMessages = async () =>
        (await builderHandle.entries({}, 50, undefined, context)).items
          .filter((item) => item.kind === "pi.user")
          .map((item) => (item.model?.[0] as { content?: unknown } | undefined)?.content);

      // 1. `directory` runs without parking.
      const senderHandle = (await harness.conversation(sender.id, context))!;
      const dirSub = await senderHandle.submit({ type: "input", content: "check directory" }, context);
      expect((await dirSub.wait(context)).status).toBe("done");
      expect(await pendingApprovals(harness, [sender.id])).toHaveLength(0);

      // 2. `send` parks in ApprovalsDoc and delivers nothing while pending or rejected.
      const rejectedSend = await senderHandle.submit({ type: "input", content: "try send" }, context);
      let [pending] = await waitForPending(harness, sender.id);
      expect(pending.tool).toBe("agents");
      expect(pending.arguments).toEqual({
        action: "send",
        name: "Builder",
        message: "UNAPPROVED_INSTRUCTION",
      });
      expect(await builderMessages()).toEqual([]);
      await replyApproval(harness, sender.id, pending.key, "reject");
      await rejectedSend.wait(context);
      expect(await builderMessages()).toEqual([]);

      // 3. Approving `send` delivers the message to Builder.
      const approvedSend = await senderHandle.submit({ type: "input", content: "approved send" }, context);
      [pending] = await waitForPending(harness, sender.id);
      expect(await builderMessages()).toEqual([]);
      await replyApproval(harness, sender.id, pending.key, "once");
      await approvedSend.wait(context);
      await builderHandle.waitForIdle(context);
      expect(await builderMessages()).toEqual(["APPROVED_INSTRUCTION"]);
    } finally {
      await harness.close(context);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 30_000);

  test("codemode nested calls to schedule, agents(send), and MCP tools are gated through Approvals", async () => {
    const home = await mkdtemp(join(tmpdir(), "hearth-approvals-codemode-"));
    const here = dirname(fileURLToPath(import.meta.url));
    const mcpFixture = join(here, "fixtures", "faux-mcp.ts");
    const mcp = await buildMcpTools(
      { mcpServers: { faux: { command: "bun", args: ["run", mcpFixture] } } },
      join(home, "mcp.json")
    );
    const faux = fauxProvider();
    faux.setResponses([
      toolCall("codemode", {
        code: [
          'const listed = await tools.schedule({ action: "list" });',
          'const created = await tools.schedule({ action: "create", name: "Codemode job", prompt: "Ping", schedule: { kind: "daily", time: "09:00", timezone: "UTC" } });',
          'const sent = await tools.agents({ action: "send", name: "PeerBot", message: "FROM_CODEMODE" });',
          'const echoed = await tools.faux__echo({ text: "mcp-via-codemode" });',
          'text([listed, created, sent, echoed].join(" | "));',
        ].join("\n"),
      }),
      fauxAssistantMessage([fauxText("Script finished after approvals.")]),
      fauxAssistantMessage([fauxText("PeerBot ack.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = hearthRegistry(home, { namespaces: mcpNamespaces(mcp.summary) });
    registry.install({ name: "mcp", tools: mcp.tools, sections: [mcpSection(mcp.summary)] });
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    harness.resume();
    try {
      const caller = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
        context
      );
      const peer = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
        context
      );
      await setAutoAccept(harness, peer.id, true, context);
      await harness.commit(
        (tx) =>
          registerAgent(tx, "PeerBot", {
            conversationId: peer.id as number,
            host: "local",
            pinned: true,
            createdAt: 1,
            updatedAt: 1,
          }),
        context
      );

      const callerHandle = (await harness.conversation(caller.id, context))!;
      const sub = await callerHandle.submit({ type: "input", content: "run script" }, context);

      // `schedule({ action: "list" })` inside codemode passes ungated, then `schedule({ action: "create" })` parks!
      let [pending] = await waitForPending(harness, caller.id);
      expect(pending.tool).toBe("schedule");
      expect(pending.arguments).toMatchObject({ action: "create", name: "Codemode job" });
      expect((await listScheduledTasks(harness, context)).tasks).toHaveLength(0);
      await replyApproval(harness, caller.id, pending.key, "once");

      // Next, `agents({ action: "send" })` inside codemode parks!
      [pending] = await waitForPending(harness, caller.id);
      expect(pending.tool).toBe("agents");
      expect(pending.arguments).toMatchObject({ action: "send", name: "PeerBot", message: "FROM_CODEMODE" });
      await replyApproval(harness, caller.id, pending.key, "once");

      // Finally, `faux__echo` inside codemode parks!
      [pending] = await waitForPending(harness, caller.id);
      expect(pending.tool).toBe("faux__echo");
      expect(pending.arguments).toEqual({ text: "mcp-via-codemode" });
      await replyApproval(harness, caller.id, pending.key, "once");

      expect((await sub.wait(context)).status).toBe("done");
      expect((await listScheduledTasks(harness, context)).tasks.map((t) => t.name)).toEqual(["Codemode job"]);
      const results = JSON.stringify((await callerHandle.entries({}, 20, undefined, context)).items);
      expect(results).toContain("echo: mcp-via-codemode");
    } finally {
      await harness.close(context);
      mcp.close();
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);
});
