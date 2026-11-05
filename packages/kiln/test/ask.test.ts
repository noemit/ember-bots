import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { AskTool, clearPendingQuestions, pendingQuestions, replyQuestion } from "../src/ask";

const context = BACKGROUND_CONTEXT;

const toolCall = (name: string, args: Record<string, any>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

describe("ask tool", () => {
  test("a question parks, then the answer lands in the tool result", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      toolCall("ask", { question: "Deploy to production?", options: ["yes", "no"] }),
      fauxAssistantMessage([fauxText("Deploying, then.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install({ name: "ask", tools: [AskTool] });
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const submission = await root.submit({ type: "input", content: "ask me" }, context);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const pending = await pendingQuestions(harness, [root.id]);
    expect(pending).toHaveLength(1);
    expect(pending[0].question).toBe("Deploy to production?");
    expect(pending[0].options).toEqual(["yes", "no"]);

    expect(await replyQuestion(harness, root.id, pending[0].key, "yes")).toBe(true);
    const settled = await submission.wait(context);
    expect(settled.status).toBe("done");

    // The waiting tool received the answer; the model carried on and finished the run.
    const results = (await root.entries({}, 20, undefined, context)).items.filter(
      (entry) => entry.kind === "pi.tool-result"
    );
    expect(results).toHaveLength(1);
    const serialized = JSON.stringify(results[0]);
    expect(serialized).toContain("The user answered: yes");
    expect(await pendingQuestions(harness, [root.id])).toHaveLength(0);
    await harness.close(context);
  });

  test("a dismissed question fails the tool call without failing the run", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      toolCall("ask", { question: "Proceed?" }),
      fauxAssistantMessage([fauxText("Standing down.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install({ name: "ask", tools: [AskTool] });
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const submission = await root.submit({ type: "input", content: "ask me" }, context);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const pending = await pendingQuestions(harness, [root.id]);
    expect(pending).toHaveLength(1);
    await replyQuestion(harness, root.id, pending[0].key, null);
    const settled = await submission.wait(context);
    expect(settled.status).toBe("done");
    await harness.close(context);
  });

  test("aborting a run parked on a question resolves and clears the prompt", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      toolCall("ask", { question: "Proceed?" }),
      fauxAssistantMessage([fauxText("Standing down.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install({ name: "ask", tools: [AskTool] });
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    await root.submit({ type: "input", content: "ask me" }, context);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await pendingQuestions(harness, [root.id])).toHaveLength(1);

    // The parked question must observe the abort so the conversation can go idle; it used to deadlock.
    await Promise.race([
      root.abort(context),
      new Promise((_, reject) => setTimeout(() => reject(new Error("abort deadlocked on a parked question")), 3_000)),
    ]);
    await clearPendingQuestions(harness, root.id);
    expect(await pendingQuestions(harness, [root.id])).toHaveLength(0);
    await harness.close(context);
  });
});
