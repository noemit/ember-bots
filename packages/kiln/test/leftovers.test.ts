import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { setAutoAccept } from "../src/approvals";
import { scanLeftovers, resetProcessCache } from "../src/processes";
import { hearthRegistry } from "../src/registry";
import { sessionEnv, scratchDirFor } from "../src/scratch";

/**
 * The whole loop, with a real shell and a real process table: the environment Hearth gives a
 * session, the command that leaves something running, the note the agent gets back, and the scan a
 * client reads. Only the model is simulated — everything below the model is the code that ships.
 */
const context = BACKGROUND_CONTEXT;

const toolCall = (name: string, args: Record<string, any>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

let home: string;
let harness: HarnessType;
let conversationId: number;
let killed: number[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "hearth-leftovers-"));
  const faux = fauxProvider();
  faux.setResponses([
    toolCall("bash", { command: "sleep 60 & echo started" }),
    fauxAssistantMessage([fauxText("left it running")]),
    toolCall("bash", { command: "echo \"TMP=$TMPDIR\"; ls -d \"$TMPDIR\"" }),
    fauxAssistantMessage([fauxText("checked")]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = await openNodeSqliteStorage(join(home, "hearth.sqlite"));
  harness = await Harness.open(
    storage,
    {
      models,
      registry: hearthRegistry(home),
      // Exactly what `src/index.ts` does for a real command.
      env: ({ cwd, conversationId: id }) => new NodeExecutionEnv({
        cwd: cwd ?? home,
        // Exactly what `src/index.ts` builds: the session's env plus the file this command's shell
        // records its background children in. Without the second half the note can only ever appear
        // on Linux, which reads /proc instead.
        shellEnv: {
          ...sessionEnv(home, Number(id)),
          HEARTH_LEFTOVERS: join(home, "leftovers", "cmd-" + String(id) + "-" + String(Date.now()) + ".pids"),
        },
      }),
    },
    context
  );
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  conversationId = root.id as number;
  await setAutoAccept(harness, root.id, true, context);
  await (await root.submit({ type: "input", content: "leave something running" }, context)).wait(context);
  // A second turn, so the "left nothing behind" case is a real command too.
  await (await root.submit({ type: "input", content: "check the scratch directory" }, context)).wait(context);
});

afterAll(async () => {
  for (const pid of killed) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await harness.close(context);
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const toolResults = async (): Promise<string[]> => {
  const conversation = await harness.conversation(conversationId as never, context);
  // `entries()` pages newest first; these assertions are about what happened in order.
  const entries = (await conversation!.entries({}, 100, undefined, context)).items
    .filter((entry) => entry.kind === "pi.tool-result")
    .reverse();
  return entries.map((entry) =>
    (entry.model ?? [])
      .flatMap((message) => {
        const content: unknown = message.content;
        return Array.isArray(content) ? content : [content];
      })
      .map((block: unknown) => {
        if (block === undefined || typeof block !== "object") return "";
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("\n")
  );
};

describe("a command that leaves something running", () => {
  test("the agent is told, with the command that ends it", async () => {
    const results = await toolResults();
    expect(results).toHaveLength(2);
    const note = results[0] ?? "";
    expect(note).toContain("Left running");
    expect(note).toContain("sleep 60");
    // The next step is copyable, not an obligation to remember.
    expect(note).toMatch(/kill \d+/);
    expect(note).toContain("Stop button");
  });

  test("the scan attributes it to this conversation, with its cost", async () => {
    resetProcessCache();
    const scan = scanLeftovers({ fresh: true });
    const mine = scan.byConversation.get(conversationId) ?? [];
    expect(mine.length).toBeGreaterThanOrEqual(1);
    const sleep = mine.find((entry) => entry.command.includes("sleep 60"));
    expect(sleep).toBeDefined();
    // A pid this test can clean up, and a size that came from the kernel rather than from a default.
    expect(sleep!.pid).toBeGreaterThan(1);
    expect(sleep!.rssBytes).toBeGreaterThan(0);
    expect(sleep!.startedAt).toBeGreaterThan(Date.now() - 5 * 60_000);
    killed.push(sleep!.pid);
  });

  test("another conversation's command is not affected by the note", async () => {
    // The second command left nothing, so its result carries no note — the line is a diff, not a
    // standing warning repeated on every call.
    const results = await toolResults();
    expect(results[1]).not.toContain("Left running");
  });
});

describe("the scratch directory a command actually gets", () => {
  test("TMPDIR points into HEARTH_HOME, on disk, and it exists", async () => {
    const results = await toolResults();
    const scratch = scratchDirFor(home, conversationId);
    // `echo` prints it and `ls -d` confirms the directory is really there.
    expect(results[1]).toContain(`TMP=${scratch}`);
    expect(results[1]?.split(scratch).length).toBeGreaterThanOrEqual(3);
    // Under the host's own home, not the platform's temp directory.
    expect(scratch.startsWith(home)).toBe(true);
    expect(readdirSync(home)).toContain("tmp");
  });
});
