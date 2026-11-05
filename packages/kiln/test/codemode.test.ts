import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { hearthCodemodeExtensions, ScratchpadTool } from "../src/codemode";

const context = BACKGROUND_CONTEXT;

/** A `ToolExecutionApi` stand-in for driving one tool directly, as `test/agents.test.ts` does. */
const toolApi = (harness: Harness, conversationId: number) =>
  ({
    conversationId,
    // Two arguments is the session-scoped form; three is a conversation document.
    snapshot: (token: any, first: any, second?: any) =>
      second === undefined ? (harness.snapshot as any)(token, first) : (harness.snapshot as any)(token, first, second),
    commit: (change: any, ctx: any) => harness.commit(change, ctx),
  }) as any;

const textOf = (result: { output?: unknown }): string =>
  Array.isArray(result.output)
    ? result.output
        .map((item) => (item as { text?: string }).text ?? "")
        .join("\n")
        .trim()
    : "";

const toolResults = async (harness: Harness, conversationId: number): Promise<string> => {
  const conversation = await harness.conversation(conversationId as never, context);
  const page = await conversation!.entries({}, 50, undefined, context);
  const results = page.items.filter((entry) => entry.kind === "pi.tool-result");
  return JSON.stringify(results.map((entry) => entry.model));
};

const toolCall = (name: string, args: Record<string, any>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const plainHarness = (faux: ReturnType<typeof fauxProvider>): Promise<Harness> => {
  const models = createModels();
  models.setProvider(faux.provider);
  return Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
};

describe("scratchpad", () => {
  test("set, list, get, delete, and clear round-trip through CodemodeStoreDoc", async () => {
    const harness = await plainHarness(fauxProvider());
    try {
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
      const api = toolApi(harness, conversation.id as unknown as number);

      // An untouched conversation has no document yet: list says so rather than failing.
      const empty = await ScratchpadTool.execute({ action: "list" }, api, context);
      expect(textOf(empty)).toContain("scratchpad is empty");

      const notes = { tags: ["a", "b"], done: false };
      const stored = await ScratchpadTool.execute({ action: "set", key: "notes", value: notes }, api, context);
      expect(stored.isError).toBeUndefined();
      expect(textOf(stored)).toBe(`Stored "notes" (${Buffer.byteLength(JSON.stringify(notes))} bytes)`);
      await ScratchpadTool.execute({ action: "set", key: "summary", value: "42 matching lines" }, api, context);

      // The same document `codemode` scripts read with load() and write with store().
      const doc = await harness.snapshot(CodemodeStoreDoc, conversation.id, context);
      expect(doc?.values).toEqual({ notes, summary: "42 matching lines" });

      const listed = textOf(await ScratchpadTool.execute({ action: "list" }, api, context));
      expect(listed).toContain("2 key(s)");
      expect(listed).toContain("- notes (");
      expect(listed).toContain("object(2 keys)");
      expect(listed).toContain("- summary (");
      expect(listed).toContain('string "42 matching lines"');

      const got = await ScratchpadTool.execute({ action: "get", key: "notes" }, api, context);
      expect(textOf(got)).toBe(JSON.stringify(notes, null, 2));
      expect((await ScratchpadTool.execute({ action: "get", key: "nope" }, api, context)).isError).toBe(true);
      expect((await ScratchpadTool.execute({ action: "get" }, api, context)).isError).toBe(true);

      // A value must be JSON; `undefined` is not, and `null` must be stored explicitly.
      expect((await ScratchpadTool.execute({ action: "set", key: "nil" }, api, context)).isError).toBe(true);
      await ScratchpadTool.execute({ action: "set", key: "nil", value: null }, api, context);
      expect(textOf(await ScratchpadTool.execute({ action: "get", key: "nil" }, api, context))).toBe("null");

      expect(textOf(await ScratchpadTool.execute({ action: "delete", key: "notes" }, api, context))).toBe('Deleted "notes"');
      const afterDelete = await harness.snapshot(CodemodeStoreDoc, conversation.id, context);
      expect(Object.keys(afterDelete?.values ?? {}).sort()).toEqual(["nil", "summary"]);

      expect(textOf(await ScratchpadTool.execute({ action: "clear" }, api, context))).toBe("Cleared 2 key(s).");
      const cleared = await harness.snapshot(CodemodeStoreDoc, conversation.id, context);
      expect(cleared?.values).toEqual({});
    } finally {
      await harness.close(context);
    }
  }, 20_000);
});

describe("hearthCodemodeExtensions", () => {
  test("installs codemode, tool-search, and scratchpad; HEARTH_CODEMODE=off leaves only scratchpad", () => {
    const on = hearthCodemodeExtensions({ env: {} });
    try {
      expect(on.extensions.map((extension) => extension.name)).toEqual(["codemode", "tool-search", "scratchpad"]);
      const codemode = on.extensions[0].tools?.[0];
      // Scripts cannot start scripts: only the model is offered `codemode`.
      expect(codemode?.callers).toEqual(["model"]);
      expect(codemode?.replay).toBe("safe");
      const scratchpad = on.extensions[2].tools?.[0];
      expect(scratchpad?.name).toBe("scratchpad");
      expect(scratchpad?.callers).toEqual(["model", "tools"]);
      expect(scratchpad?.replay).toBe("safe");
    } finally {
      on.close();
    }
    for (const off of ["off", "0", "false", " OFF "]) {
      const disabled = hearthCodemodeExtensions({ env: { HEARTH_CODEMODE: off } });
      expect(disabled.extensions.map((extension) => extension.name)).toEqual(["scratchpad"]);
      disabled.close();
    }
    const explicitOn = hearthCodemodeExtensions({ env: { HEARTH_CODEMODE: "on" } });
    expect(explicitOn.extensions).toHaveLength(3);
    explicitOn.close();
  });
});

describe("codemode", () => {
  test("a script calls tools.read, filters, stores the result, and a later turn loads it back", async () => {
    const home = await mkdtemp(join(tmpdir(), "hearth-codemode-"));
    const file = join(home, "log.txt");
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index} ${index % 7 === 0 ? "needle" : "straw"}`);
    await Bun.write(file, lines.join("\n"));
    const kept = lines.filter((line) => line.includes("needle"));
    // The script source is a JSON string in the tool call, so Windows separators are escaped.
    const path = file.replace(/\\/g, "\\\\");

    const faux = fauxProvider();
    faux.setResponses([
      toolCall("codemode", {
        code: [
          `const raw = await tools.read({ path: "${path}" });`,
          `const kept = String(raw).split("\\n").filter((line) => line.includes("needle"));`,
          `store("filtered", kept);`,
          `text(kept.length + " lines kept");`,
        ].join("\n"),
      }),
      fauxAssistantMessage([fauxText("Filtered.")]),
      toolCall("codemode", { code: `const kept = load("filtered"); text(kept.length + " loaded");` }),
      fauxAssistantMessage([fauxText("Read it back.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const codemode = hearthCodemodeExtensions({ env: {} });
    for (const extension of codemode.extensions) registry.install(extension);
    registry.install(CodingTools);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
      context
    );
    harness.resume();
    try {
      const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
      const id = conversation.id as unknown as number;
      await (await conversation.submit({ type: "input", content: "filter the log" }, context)).wait(context);

      // Only the summary entered the transcript, not the 200 lines the script read.
      const first = await toolResults(harness, id);
      expect(first).toContain(`${kept.length} lines kept`);
      expect(first).not.toContain("line 199 straw");

      // The script's store() landed in the conversation's rewindable document.
      const doc = await harness.snapshot(CodemodeStoreDoc, conversation.id, context);
      expect(doc?.values.filtered).toEqual(kept);

      // `scratchpad` reads the very document the script wrote.
      const api = toolApi(harness, id);
      const got = JSON.parse(textOf(await ScratchpadTool.execute({ action: "get", key: "filtered" }, api, context)));
      expect(got).toEqual(kept);

      // A second script sees it with load(), so the store really is shared and durable.
      await (await conversation.submit({ type: "input", content: "read it back" }, context)).wait(context);
      expect(await toolResults(harness, id)).toContain(`${kept.length} loaded`);
    } finally {
      await harness.close(context);
      codemode.close();
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
    }
  }, 120_000);
});

describe("codemode replay", () => {
  test("after a crash, a finished call comes from the journal and is not run again", async () => {
    const home = await mkdtemp(join(tmpdir(), "hearth-codemode-replay-"));
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bAttempts = 0;

    // A read-only tool: replay "safe", so the call a crash interrupted reruns while the finished
    // ones are served from the journal.
    const probe: ToolRegistration = defineTool({
      name: "probe",
      description: "Return a value for an id (stands in for a read-only file or MCP tool).",
      parameters: obj({ id: str() }),
      replay: "safe",
      callers: ["model", "tools"],
      execute: async (args: { id: string }) => {
        calls.push(args.id);
        if (args.id === "b") {
          bAttempts += 1;
          // The first attempt never finishes: the "crash" happens while it is running.
          if (bAttempts === 1) await hang;
        }
        return { output: [{ type: "text" as const, text: `value-${args.id}` }] };
      },
    });
    const probeExtension = defineExtension({ name: "probe", tools: [probe] });
    const script = [
      'const a = await tools.probe({ id: "a" });',
      'const b = await tools.probe({ id: "b" });',
      'text(String(a) + "|" + String(b));',
    ].join("\n");

    const open = async (faux: ReturnType<typeof fauxProvider>, storagePath: string) => {
      const models = createModels();
      models.setProvider(faux.provider);
      const registry: Registry = createRegistry();
      const extensions = hearthCodemodeExtensions({ env: {} });
      for (const extension of extensions.extensions) registry.install(extension);
      registry.install(probeExtension);
      const storage = await openNodeSqliteStorage(storagePath);
      const harness = await Harness.open(storage, { models, registry }, context);
      harness.resume();
      return { harness, codemode: extensions };
    };

    const storagePath = join(home, "hearth.sqlite");
    const before = fauxProvider();
    before.setResponses([toolCall("codemode", { code: script }), fauxAssistantMessage([fauxText("done")])]);
    const crashed = await open(before, storagePath);
    const conversation = await crashed.harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    const id = conversation.id as unknown as number;
    await conversation.submit({ type: "input", content: "run it" }, context);

    // Wait until the script's first call is committed and it is stuck in the second.
    const deadline = Date.now() + 60_000;
    while (!(calls.includes("a") && bAttempts === 1)) {
      if (Date.now() > deadline) throw new Error(`the script never reached the second call (saw ${calls.join(",")})`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(calls).toEqual(["a", "b"]);

    // The "crash": this harness is abandoned where it stands — its script waits on a call that
    // never answers, and nothing more is written by it. (Closing it would join the stuck task.)
    const after = fauxProvider();
    after.setResponses([fauxAssistantMessage([fauxText("recovered")])]);
    const reopened = await open(after, storagePath);
    try {
      await reopened.harness.waitForIdle(context);
      const deadline2 = Date.now() + 60_000;
      for (;;) {
        const results = await toolResults(reopened.harness, id);
        if (results.includes("value-a|value-b")) break;
        if (Date.now() > deadline2) throw new Error(`the replayed run never finished: ${results}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // The finished call was replayed from the journal; only the interrupted one ran again.
      expect(calls).toEqual(["a", "b", "b"]);
      expect(calls.filter((call) => call === "a")).toHaveLength(1);
      // The recovered run carried on with a normal model turn, which answered for good.
      expect(after.getPendingResponseCount()).toBe(0);
    } finally {
      release?.();
      await reopened.harness.close(context);
      reopened.codemode.close();
      // The abandoned harness still holds the sqlite file; a leftover temp dir is not a failure.
      await rm(home, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(() => undefined);
    }
  }, 180_000);
});
