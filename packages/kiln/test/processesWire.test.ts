import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { hearthConfig } from "../src/config";
import { FileCredentialStore } from "../src/credentials";
import { startHearthServer, type HearthServer } from "../src/server";
import type { LeftProcess, ProcessScan } from "../src/processes";

/**
 * The wire behind a session's "left running" notice.
 *
 * The process table is faked (`Deps.processes`) so the assertions are about Hearth's answers rather
 * than about whatever happens to be running on the machine under test — except for the stop route,
 * which is exercised against **real** processes this test spawns: a signal is only trustworthy if
 * something actually received it.
 */
const context = BACKGROUND_CONTEXT;
const TOKEN = "test-token-0123456789abcdef0123456789abcdef";

let home: string;
let harness: HarnessType;
let server: HearthServer;
let conversationId: number;
let leftovers: Map<number, LeftProcess[]>;
let memoryLevel: "normal" | "low" | "critical";
/** Pids this test really spawned: the fake scan reports one as present only while it is alive. */
const real = new Set<number>();
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const megabytes = (count: number): number => Math.round(count * 1024 * 1024);

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "hearth-processes-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  const storage = await openNodeSqliteStorage(join(home, "hearth.sqlite"));
  harness = await Harness.open(
    storage,
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  conversationId = conversation.id as number;
  leftovers = new Map();
  server = startHearthServer({
    config: hearthConfig({ home, port: 0, workspace: home }),
    token: TOKEN,
    storage,
    harness,
    models,
    defaultAgent: { model: { provider: "faux", modelId: "faux-1" } },
    store: new FileCredentialStore(join(home, "auth.json")),
    version: "9.9.9",
    processes: {
      scan: (): ProcessScan => {
        // A real scan only ever lists living processes, so a fake that kept a stopped pid would
        // assert the opposite of what the route promises.
        const byConversation = new Map<number, LeftProcess[]>();
        for (const [id, list] of leftovers) {
          const kept = list.filter((entry) => !real.has(entry.pid) || alive(entry.pid));
          if (kept.length > 0) byConversation.set(id, kept);
        }
        return { byConversation, all: [...byConversation.values()].flat() };
      },
      memory: () => ({ totalBytes: 16 * 1024 ** 3, availableBytes: 2 * 1024 ** 3, level: memoryLevel }),
    },
  });
  memoryLevel = "normal";
});

afterAll(async () => {
  await server.close();
  await harness.close(context);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

const call = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
};

/** Wait for a spawned process to install its handlers before signalling it (see the stop tests). */
const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("a summary says what the session left running", () => {
  test("nothing running: the field is absent, so an ordinary summary is unchanged", async () => {
    const { body } = await call("/conversations");
    const summary = body.conversations.find((entry: { id: number }) => entry.id === conversationId);
    expect(summary.processes).toBeUndefined();
  });

  test("the count, the total and the heaviest few travel with the summary", async () => {
    const processes: LeftProcess[] = Array.from({ length: 7 }, (_, index) => ({
      pid: 900 + index,
      command: `worker-${index}`,
      rssBytes: megabytes(7 - index),
      startedAt: 1_700_000_000_000 + index,
    }));
    leftovers.set(conversationId, processes);
    const { body } = await call("/conversations");
    const summary = body.conversations.find((entry: { id: number }) => entry.id === conversationId);
    expect(summary.processes.count).toBe(7);
    expect(summary.processes.rssBytes).toBe(megabytes(7 + 6 + 5 + 4 + 3 + 2 + 1));
    // Five are enough to draw the notice; the rest are one request away.
    expect(summary.processes.items).toHaveLength(5);
    expect(summary.processes.items[0]).toEqual({
      pid: 900,
      command: "worker-0",
      rssBytes: megabytes(7),
      startedAt: 1_700_000_000_000,
    });
  });

  test("the host's memory rides with the list, because that is what makes it a warning", async () => {
    memoryLevel = "low";
    const { body } = await call("/conversations");
    expect(body.host.memory).toEqual({ totalBytes: 16 * 1024 ** 3, availableBytes: 2 * 1024 ** 3, level: "low" });
    memoryLevel = "normal";
  });
});

describe("the processes route", () => {
  test("it lists the conversation's own processes with the host's memory", async () => {
    const { status, body } = await call(`/conversations/${conversationId}/processes`);
    expect(status).toBe(200);
    expect(body.processes.map((entry: LeftProcess) => entry.pid)).toEqual([900, 901, 902, 903, 904, 905, 906]);
    expect(body.host.memory.level).toBe("normal");
  });

  test("another conversation's processes are not this one's", async () => {
    leftovers.set(999_999, [{ pid: 1, command: "someone else", rssBytes: 1, startedAt: 0 }]);
    const { body } = await call(`/conversations/${conversationId}/processes`);
    expect(body.processes.map((entry: LeftProcess) => entry.pid)).not.toContain(1);
    leftovers.delete(999_999);
  });
});

describe("the stop route", () => {
  const spawnIgnoringTerm = (): number => {
    const child = spawn("sh", ["-c", "trap '' TERM; sleep 60"], { stdio: "ignore" });
    real.add(child.pid!);
    return child.pid!;
  };
  const spawnYield = (): number => {
    const pid = spawn("sh", ["-c", "sleep 60"], { stdio: "ignore" }).pid!;
    real.add(pid);
    return pid;
  };
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("a polite stop ends an ordinary process, and the list comes back without it", async () => {
    const pid = spawnYield();
    await settle();
    leftovers.set(conversationId, [{ pid, command: "sleep 60", rssBytes: megabytes(1), startedAt: Date.now() }]);
    const { status, body } = await call(`/conversations/${conversationId}/processes/stop`, {
      method: "POST",
      body: JSON.stringify({ pids: [pid] }),
    });
    expect(status).toBe(200);
    expect(body.results).toEqual([{ pid, command: "sleep 60", outcome: "stopped" }]);
    expect(alive(pid)).toBe(false);
    // The answer is the state after the stop, so a client does not have to re-read to redraw.
    expect(body.processes).toEqual([]);
  });

  test("a process that ignores SIGTERM is refused, and force ends it", async () => {
    const pid = spawnIgnoringTerm();
    await settle();
    leftovers.set(conversationId, [{ pid, command: "trap TERM", rssBytes: megabytes(1), startedAt: Date.now() }]);
    const polite = await call(`/conversations/${conversationId}/processes/stop`, {
      method: "POST",
      body: JSON.stringify({ pids: [pid] }),
    });
    expect(polite.body.results[0]).toEqual({ pid, command: "trap TERM", outcome: "refused" });
    expect(alive(pid)).toBe(true);

    const forced = await call(`/conversations/${conversationId}/processes/stop`, {
      method: "POST",
      body: JSON.stringify({ pids: [pid], force: true }),
    });
    expect(forced.body.results[0].outcome).toBe("stopped");
    expect(alive(pid)).toBe(false);
    leftovers.set(conversationId, []);
  });

  test("a pid that is not this conversation's is not signalled", async () => {
    // "Not mine" answers `gone`: from this session's point of view the process is simply not there
    // to stop, and the client's next list is the truth. Nothing is signalled.
    const pid = spawnYield();
    await settle();
    leftovers.set(conversationId, []);
    const { body } = await call(`/conversations/${conversationId}/processes/stop`, {
      method: "POST",
      body: JSON.stringify({ pids: [pid], force: true }),
    });
    expect(body.results[0].outcome).toBe("refused");
    expect(alive(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
  });

  test("a bad request names what to send instead", async () => {
    const missing = await call(`/conversations/${conversationId}/processes/stop`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("pids");

    const wrong = await call(`/conversations/${conversationId}/processes/stop`, {
      method: "POST",
      body: JSON.stringify({ pids: "12" }),
    });
    expect(wrong.status).toBe(400);
  });
});

describe("health reports the host's own footprint", () => {
  test("memory, heap and how much is left running", async () => {
    leftovers.set(conversationId, [
      { pid: 901, command: "vite", rssBytes: megabytes(310), startedAt: 1 },
      { pid: 902, command: "thumbserve.py", rssBytes: megabytes(23), startedAt: 2 },
    ]);
    const { body } = await call("/health");
    expect(body.memory.level).toBe("normal");
    expect(body.memory.rssBytes).toBeGreaterThan(0);
    expect(body.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(body.memory.leftRunning).toBe(2);
    leftovers.set(conversationId, []);
  });
});
