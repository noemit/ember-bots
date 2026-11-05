import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Approvals, clearPendingApprovals, pendingApprovals, replyApproval, setAutoAccept } from "../src/approvals";

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
