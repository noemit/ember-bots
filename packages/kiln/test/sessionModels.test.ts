import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc, configure, createRegistry, Harness, MemoryStorage, type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { MetaDoc } from "../src/meta";
import { Sessions, SessionsDoc, SessionTool } from "../src/sessions";

const context = BACKGROUND_CONTEXT;
const inherited = { provider: "Acme", modelId: "team/reasoner/v2" };
type ModelPage = {
  models: Array<{ provider: string; modelId: string; name: string; model: string }>;
  inheritedDefault: typeof inherited | null;
  total: number;
  offset: number;
  nextOffset: number | null;
  note: string;
};

const setup = async (options: { many?: boolean; noDefault?: boolean; delegates?: boolean } = {}) => {
  const faux = fauxProvider({ provider: "Acme", models: [
    { id: "team/reasoner/v2", name: "Deep Thinker" },
    { id: "fast-1", name: "Quick Writer" },
    { id: "restricted", name: "Credential Restricted" },
    ...(options.many ? Array.from({ length: 103 }, (_, i) => ({ id: `extra-${String(i).padStart(3, "0")}`, name: `Extra ${i}` })) : []),
  ] });
  const secret = "SESSION_MODELS_SECRET_MUST_NOT_LEAK";
  const catalog = faux.models.map((model) => ({
    ...model, baseUrl: `https://private.invalid/${secret}`, headers: { Authorization: secret },
    apiKey: secret, credential: { token: secret }, internalMetadata: { secret },
  }));
  const unavailable = fauxProvider({ provider: "Locked", models: [{ id: "locked-chat", name: "Locked Chat" }] });
  const models = createModels();
  models.setProvider({ ...faux.provider, getModels: () => catalog,
    getAllModels: () => catalog,
    filterModels: (items) => items.filter((item) => item.id !== "restricted"),
  });
  models.setProvider({ ...unavailable.provider,
    auth: { apiKey: { name: "Missing API key", resolve: async () => undefined } },
  });
  const storage = new MemoryStorage();
  const registry = createRegistry();
  registry.install(Sessions); // Deliberately no codemode extension.
  const harness = await Harness.open(storage, { models, registry }, context);
  const leader = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  await harness.commit(async (tx) => {
    if (!options.noDefault) await configure(tx, leader.id, { model: inherited });
    if (options.delegates !== undefined) (await tx.doc(MetaDoc, leader.id)).delegates = options.delegates;
  }, context);
  const api = {
    taskId: "session-models-test", conversationId: leader.id, models,
    snapshot: harness.snapshot.bind(harness), commit: harness.commit.bind(harness),
    conversation: harness.conversation.bind(harness),
    agent: async () => ({ extensions: [Sessions], ...(options.noDefault ? {} : { model: inherited }) }),
  } as unknown as ToolExecutionApi;
  const call = async (args: Parameters<typeof SessionTool.execute>[0]) => {
    const result = await SessionTool.execute(args, api, context);
    return (result.output ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
  };
  const page = async (args: Omit<Parameters<typeof SessionTool.execute>[0], "action"> = {}) =>
    JSON.parse(await call({ action: "models", ...args })) as ModelPage;
  const conversations = async () => (await storage.scanConversations({}, 200, undefined, context)).items;
  return { harness, leader, models, faux, api, call, page, conversations, secret };
};

describe("session models: direct discovery and spawn", () => {
  test("the session tool permits both direct model calls and nested tools such as codemode", () => {
    // SDK's absent callers means both; explicit restrictions must retain both paths.
    const callers = SessionTool.callers ?? ["model", "tools"];
    expect(callers).toContain("model");
    expect(callers).toContain("tools");
    expect(Sessions.tools).toContain(SessionTool);
  });

  test("direct execution exposes only available public chat fields and preserves the inherited default", async () => {
    const f = await setup();
    try {
      expect(f.models.getModels().some((model) => model.provider === "Locked")).toBe(true);
      expect(f.models.getModels().some((model) => model.id === "restricted")).toBe(true);
      const page = await f.page();
      expect(page.models).toHaveLength(2);
      expect(page.total).toBe(2);
      expect(page.offset).toBe(0);
      expect(page.nextOffset).toBeNull();
      expect(page.inheritedDefault).toEqual(inherited);
      expect(page.note).toEqual(expect.any(String));
      expect(page.note).toMatch(/credential|configured/i);
      expect(page.note).toMatch(/quota|access/i);
      expect(page.models).toContainEqual({ provider: "Acme", modelId: "team/reasoner/v2", name: "Deep Thinker", model: "Acme/team/reasoner/v2" });
      for (const model of page.models) expect(Object.keys(model).sort()).toEqual(["model", "modelId", "name", "provider"]);
      expect(JSON.stringify(page)).not.toContain(f.secret);
      expect(JSON.stringify(page)).not.toContain("private.invalid");
      expect(await f.conversations()).toHaveLength(1);
      expect(await f.harness.snapshot(SessionsDoc, f.leader.id, context)).toBeUndefined();
    } finally { await f.harness.close(context); }
  });

  test.each([
    ["aCmE", ["fast-1", "team/reasoner/v2"]],
    ["REASONER/V2", ["team/reasoner/v2"]],
    ["dEeP tHiNkEr", ["team/reasoner/v2"]],
    ["not-in-this-catalog", []],
  ])("searches provider, exact ID text and display name without case sensitivity: %s", async (query, ids) => {
    const f = await setup();
    try {
      const page = await f.page({ query });
      expect(page.models.map((model) => model.modelId).sort()).toEqual(ids);
      expect(page.total).toBe(ids.length);
      expect(page.nextOffset).toBeNull();
    } finally { await f.harness.close(context); }
  });

  test("paginates the filtered catalog with a default of 50 and permits 100", async () => {
    const f = await setup({ many: true });
    try {
      const first = await f.page();
      expect(first.models).toHaveLength(50);
      expect(first.total).toBe(105);
      expect(first.nextOffset).toBe(50);
      const second = await f.page({ offset: first.nextOffset! });
      const third = await f.page({ offset: second.nextOffset! });
      expect(second.models).toHaveLength(50);
      expect(second.offset).toBe(50);
      expect(second.nextOffset).toBe(100);
      expect(third.models).toHaveLength(5);
      expect(third.nextOffset).toBeNull();
      expect(new Set([...first.models, ...second.models, ...third.models].map((model) => model.model)).size).toBe(105);
      expect((await f.page({ limit: 100 })).models).toHaveLength(100);
      const filtered = await f.page({ query: "extra", limit: 2, offset: 2 });
      expect(filtered.models).toHaveLength(2);
      expect(filtered.total).toBe(103);
      expect(filtered.offset).toBe(2);
      expect(filtered.nextOffset).toBe(4);
      const end = await f.page({ offset: 999 });
      expect(end.models).toEqual([]);
      expect(end.total).toBe(105);
      expect(end.nextOffset).toBeNull();
    } finally { await f.harness.close(context); }
  });

  test.each([
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: Number.NaN },
    { offset: -1 }, { offset: 1.5 }, { offset: Number.POSITIVE_INFINITY },
    { query: "q".repeat(201) },
  ])("rejects invalid discovery bounds without mutation: %j", async (args) => {
    const f = await setup();
    try {
      const result = await f.call({ action: "models", ...args });
      expect(result).toMatch(/Kiln/i);
      expect(result).toMatch(/limit|offset|query/i);
      expect(result).toMatch(/try|adjust|choose|use/i);
      expect(await f.conversations()).toHaveLength(1);
      expect(await f.harness.snapshot(SessionsDoc, f.leader.id, context)).toBeUndefined();
      expect((await f.page({ query: "q".repeat(200), limit: 1, offset: 0 })).models).toEqual([]);
    } finally { await f.harness.close(context); }
  });

  test("provider errors never disclose credentials in discovery or spawn refusals", async () => {
    const f = await setup();
    try {
      f.models.getAvailable = async () => { throw new Error("Provider failed at https://private.invalid/" + f.secret); };
      for (const args of [{ action: "models" }, { action: "spawn", name: "denied", brief: "Do work.", model: "Acme/fast-1" }] as const) {
        const result = await f.call(args);
        expect(result).toMatch(/Kiln/i);
        expect(result).toMatch(/try|check|configure/i);
        expect(result).not.toContain(f.secret);
        expect(result).not.toContain("private.invalid");
        expect(await f.conversations()).toHaveLength(1);
        expect(await f.harness.snapshot(SessionsDoc, f.leader.id, context)).toBeUndefined();
      }
    } finally { await f.harness.close(context); }
  });

  test("an unset default is null, and discovery remains read-only with delegation disabled", async () => {
    const f = await setup({ noDefault: true, delegates: false });
    try {
      const before = await f.harness.snapshot(MetaDoc, f.leader.id, context);
      expect((await f.page()).inheritedDefault).toBeNull();
      expect(await f.harness.snapshot(MetaDoc, f.leader.id, context)).toEqual(before);
      expect(await f.harness.snapshot(SessionsDoc, f.leader.id, context)).toBeUndefined();
      expect(await f.conversations()).toHaveLength(1);
      expect(await f.call({ action: "spawn", name: "denied", brief: "Do work." })).toMatch(/refus|not.*delegate/i);
      expect(await f.conversations()).toHaveLength(1);
    } finally { await f.harness.close(context); }
  });

  test("a returned nested-slash ID round-trips unchanged into a spawned child's configuration", async () => {
    const f = await setup();
    try {
      const chosen = (await f.page({ query: "reasoner" })).models[0]!;
      const result = await f.call({ action: "spawn", name: "nested", brief: "Inspect this project.", model: chosen.model });
      expect(result).toMatch(/started worker/i);
      const crew = await f.harness.snapshot(SessionsDoc, f.leader.id, context);
      expect((await f.harness.snapshot(AgentDoc, crew!.items.nested!.conversationId, context))!.model).toEqual(inherited);
      expect(await f.conversations()).toHaveLength(2);
    } finally { await f.harness.close(context); }
  });

  test.each(["Acme/does-not-exist", "Locked/locked-chat", "Acme/restricted", "acme/team/reasoner/v2", "Acme/TEAM/reasoner/v2", " Acme/fast-1 ", "Acme", "/fast-1", "Acme/", ""])(
    "refuses explicit unavailable or malformed model %j before creating any child", async (model) => {
      const f = await setup();
      try {
        const result = await f.call({ action: "spawn", name: "denied", brief: "Do work.", model });
        expect(result).toMatch(/Kiln/i);
        expect(result).toMatch(/cannot|needs|refus|unavailable|not available|invalid|not found/i);
        // A refusal must point at recovery, not merely announce failure.
        expect(result).toMatch(/models|credential|choose|available|provider\/model/i);
        expect(result).not.toMatch(/undefined|stack trace/i);
        expect(await f.conversations()).toHaveLength(1);
        expect(await f.harness.snapshot(SessionsDoc, f.leader.id, context)).toBeUndefined();
      } finally { await f.harness.close(context); }
    },
  );

  test("omitting the spawn model inherits even when that model is no longer available", async () => {
    const f = await setup();
    try {
      f.models.deleteProvider("Acme");
      const page = await f.page();
      expect(page.models).toEqual([]);
      expect(page.inheritedDefault).toEqual(inherited);
      f.models.getAvailable = async () => { throw new Error("Omitted spawn.model must not consult availability"); };
      expect(await f.call({ action: "spawn", name: "inherited", brief: "Do work." })).toMatch(/started worker/i);
      const crew = await f.harness.snapshot(SessionsDoc, f.leader.id, context);
      expect((await f.harness.snapshot(AgentDoc, crew!.items.inherited!.conversationId, context))!.model).toEqual(inherited);
    } finally { await f.harness.close(context); }
  });

  test("a real model turn can call session models directly without codemode, even with delegates:false", async () => {
    const f = await setup({ delegates: false });
    try {
      f.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("session", { action: "models", query: "REASONER" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Discovery complete."),
      ]);
      f.harness.resume();
      const conversation = (await f.harness.conversation(f.leader.id, context))!;
      await conversation.submit({ type: "input", content: "Find available reasoning models." }, context);
      await conversation.waitForIdle(context);
      const entries = (await conversation.entries({}, 100, undefined, context)).items;
      const results = entries.filter((entry) => entry.kind === "pi.tool-result");
      expect(results).toHaveLength(1);
      const serialized = JSON.stringify(results);
      expect(serialized).toContain("Acme/team/reasoner/v2");
      expect(serialized).not.toContain("Quick Writer");
      expect(serialized).not.toContain(f.secret);
      expect(await f.conversations()).toHaveLength(1);
    } finally { await f.harness.close(context); }
  });
});
