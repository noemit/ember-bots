import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { hearthConfig } from "../src/config";
import { FileCredentialStore } from "../src/credentials";
import { startHearthServer, type HearthServer } from "../src/server";
import { RESYNC_CLOSE_CODE, RESYNC_CLOSE_REASON, sendFrame } from "../src/stream";

/**
 * What a WebSocket send status means, and what Hearth does about each one.
 *
 * Measured against Bun 1.4.2 (`backpressureLimit` 1 MB, 2,000 frames of 64 KB, a client that stops
 * reading): 40 sends reported bytes, 17 reported `-1`, 1,943 reported `0`, and the client received
 * exactly 57 frames — so **`-1` means queued** (no gap) and **`0` means dropped** (a gap that only a
 * fresh attach can repair). The two therefore have different answers: pause and wait for `drain`, or
 * close with 1013 so the client reconnects. Treating them alike is what made a slow client pin memory
 * and rewind.
 */
const context = BACKGROUND_CONTEXT;
const TOKEN = "test-token-0123456789abcdef0123456789abcdef";

/** A socket whose `send` answers from a script, so a dropped frame is cheap to reproduce. */
const fakeSocket = (results: number[]) => {
  const sent: string[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const state: { lost?: boolean; paused?: boolean; pausedSince?: number } = {};
  return {
    state,
    sent,
    closes,
    socket: {
      send(frame: string): number {
        sent.push(frame);
        const next = results.shift();
        if (next === undefined) throw new Error("socket is gone");
        return next;
      },
      close(code?: number, reason?: string): void {
        closes.push({ code, reason });
      },
    },
  };
};

let home: string;
let harness: HarnessType;
let server: HearthServer;
let faux: ReturnType<typeof fauxProvider>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "hearth-stream-"));
  faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("Ready.")])]);
  // Inferred: `createModels()` returns the concrete type, which carries `setProvider`.
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
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
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

describe("stream frames", () => {
  test("a writable frame changes nothing", async () => {
    const { socket, state, sent, closes } = fakeSocket([7, 7, 7]);
    for (const frame of ["[]", "[{\"type\":\"run_start\"}]", "[]"]) expect(sendFrame(socket, state, frame)).toBe(true);
    expect(sent.length).toBe(3);
    expect(closes).toEqual([]);
    expect(state.lost).toBeUndefined();
  });

  test("backpressure queues the frame, and pauses the stream without a reconnect", async () => {
    // -1 is "over the buffer", not "lost": the frame is in the queue, so there is nothing to repair.
    const logged = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { socket, state, closes, sent } = fakeSocket([-1, 7, 7]);
      expect(sendFrame(socket, state, '["delta"]', "stream delta")).toBe(true);
      expect(closes).toEqual([]);
      expect(state.paused).toBe(true);
      expect(state.lost).toBeUndefined();
      // One line per pause, naming what could not be written — not one per skipped frame.
      expect(logged.mock.calls.length).toBe(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain("stream delta");
      // Nothing else is written while the socket is over its buffer: the frame after it would only
      // deepen a queue the client cannot read.
      expect(sendFrame(socket, state, '["delta2"]', "stream delta")).toBe(false);
      expect(sent).toEqual(['["delta"]']);
      // `drain` is what clears it (the server's handler does exactly this).
      state.paused = false;
      state.pausedSince = undefined;
      expect(sendFrame(socket, state, '["delta3"]', "stream delta")).toBe(true);
      expect(sent).toEqual(['["delta"]', '["delta3"]']);
    } finally {
      logged.mockRestore();
    }
  });

  test("a dropped frame closes the socket, because a stale snapshot would look like data", async () => {
    for (const results of [[0], []]) {
      const errors = spyOn(console, "error").mockImplementation(() => undefined);
      const warns = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const { socket, state, closes } = fakeSocket(results);
        // 0 is a dropped frame, and a throw is a socket already gone. Neither can be repaired by
        // replaying a snapshot this host captured when the stream attached.
        expect(sendFrame(socket, state, '["delta"]', "stream delta", { closeDelayMs: () => 0 })).toBe(false);
        expect(state.lost).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(closes).toEqual([{ code: RESYNC_CLOSE_CODE, reason: RESYNC_CLOSE_REASON }]);
        expect(RESYNC_CLOSE_CODE).toBe(1013);
        expect(RESYNC_CLOSE_REASON).toContain("resync");
        // Nothing more is written once it is being torn down.
        expect(sendFrame(socket, state, "[]")).toBe(false);
        expect(closes.length).toBe(1);
        expect(errors.mock.calls.length).toBeGreaterThan(0);
        warns.mockRestore();
      } finally {
        errors.mockRestore();
        warns.mockRestore();
      }
    }
  });

  test("a paused socket that never drains is closed after the deadline", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    const warns = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let now = 0;
      const { socket, state, closes } = fakeSocket([-1, -1]);
      const options = { now: () => now, giveUpMs: 1000, closeDelayMs: () => 0 };
      // The frame is queued, so this is a pause, not a failure.
      expect(sendFrame(socket, state, "[]", "stream delta", options)).toBe(true);
      expect(state.paused).toBe(true);
      expect(closes).toEqual([]);
      // A socket that cannot take anything for the whole deadline is not slow, it is stuck.
      now = 2000;
      expect(sendFrame(socket, state, "[]", "stream delta", options)).toBe(false);
      expect(state.lost).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closes).toEqual([{ code: RESYNC_CLOSE_CODE, reason: RESYNC_CLOSE_REASON }]);
      expect(errors.mock.calls.length).toBeGreaterThan(0);
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  });

  test("a send that throws is a dropped frame, not a crash", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { socket, state, closes } = fakeSocket([]);
      expect(sendFrame(socket, state, "[]", "keepalive", { closeDelayMs: () => 0 })).toBe(false);
      expect(state.lost).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closes).toEqual([{ code: RESYNC_CLOSE_CODE, reason: RESYNC_CLOSE_REASON }]);
    } finally {
      errors.mockRestore();
    }
  });

  test("a healthy socket still receives the attach snapshot and stays open", async () => {
    const created = await fetch(`${server.url}/conversations`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
    });
    const conversation = (await created.json()) as { id: number };
    const url = `${server.url.replace("http://", "ws://")}/conversations/${conversation.id}/events`;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } } as never);
    try {
      const snapshot = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no attach frame")), 5000);
        socket.onmessage = (event) => {
          clearTimeout(timer);
          resolve(JSON.parse(String(event.data)));
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("socket error"));
        };
      });
      // The attach frame is the live state (pi-durable 1.5.0's view), with no history in it: the
      // transcript is `GET /entries`, paged and bounded.
      expect(snapshot[0].type).toBe("view");
      expect(snapshot[0].entries).toBeUndefined();
      expect(snapshot[0].docs).toBeDefined();
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
    }
  });
});
