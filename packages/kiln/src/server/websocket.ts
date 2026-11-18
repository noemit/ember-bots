import type { Server, WebSocketHandler } from "bun";
import type { ConversationId, ConversationView, Harness } from "@earendil-works/pi-durable";
import { attachFrames, framesOf } from "../frames";
import { sendFrame } from "../stream";
import { STREAM_LIMITS, type createStreamLimiter } from "../streamLimit";
import {
  badRequest,
  decodeSegment,
  forbiddenOrigin,
  idOf,
  MAX_WS_PAYLOAD_BYTES,
  notFound,
  serverContext,
} from "./http";
import type { RouteContext, WsData } from "./types";

const context = serverContext;

const STREAM_RATE_COPY =
  "Hearth is holding new streams from this device for a moment: it reconnected several times in the last second. It keeps retrying by itself, and the conversations already open are unaffected.";
const STREAM_CONCURRENT_COPY = (limit: number) =>
  `This device already holds ${limit} live streams, which is Hearth's ceiling. Close a window, or wait for the old streams to drop — the conversations themselves are unaffected.`;

export const streamRefusal = (verdict: "rate" | "concurrent"): Response =>
  new Response(
    JSON.stringify({
      error: verdict === "rate" ? STREAM_RATE_COPY : STREAM_CONCURRENT_COPY(STREAM_LIMITS.maxConcurrent),
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": "2",
        connection: "close",
      },
    }
  );

export const createRefusalLogger = () => {
  const refusalLoggedAt = new Map<string, number>();
  return (peer: string, verdict: "rate" | "concurrent", now = Date.now()): void => {
    const last = refusalLoggedAt.get(peer) ?? 0;
    if (now - last < 5_000) return;
    refusalLoggedAt.set(peer, now);
    console.warn(
      `[hearth] refusing a stream from ${peer}: ${verdict === "rate" ? "too many reconnects" : "already holds the maximum live streams"}`
    );
  };
};

export const createWebSocketHandler = (
  harness: Harness,
  streamLimiter: ReturnType<typeof createStreamLimiter>
): WebSocketHandler<WsData> => ({
  maxPayloadLength: MAX_WS_PAYLOAD_BYTES,
  idleTimeout: 960,
  backpressureLimit: 16 * 1024 * 1024,
  closeOnBackpressureLimit: false,
  async open(ws) {
    ws.data.keepalive = setInterval(() => {
      sendFrame(ws, ws.data, "[]", "keepalive");
    }, 25_000);
    try {
      if (ws.data.conversationId) {
        const conversation = await harness.conversation(ws.data.conversationId, context);
        if (conversation === undefined) {
          ws.close();
          return;
        }
        const watch = await conversation.watch(context, { min: 50, max: 100 });
        if (ws.data.lost || ws.readyState !== 1) {
          void watch.stop();
          return;
        }
        ws.data.watch = watch;
        sendFrame(ws, ws.data, JSON.stringify(attachFrames(watch.value)), "stream view");
        let previous: ConversationView | undefined = watch.value;
        watch.start(async (call) => {
          if (call.kind !== "value") return;
          let frames;
          try {
            frames = framesOf(previous, call.value, call.ops);
          } catch (error) {
            console.error("[hearth] stream frame failed:", error);
            frames = [{ type: "changed" as const, kinds: ["unknown"] }];
          }
          previous = call.value;
          if (frames.length === 0) return;
          sendFrame(ws, ws.data, JSON.stringify(frames), "stream frame");
          if (call.retired) ws.close();
        });
      } else if (ws.data.tasks) {
        const graph = await harness.watchTaskGraph(context);
        if (ws.data.lost || ws.readyState !== 1) {
          void graph.stop();
          return;
        }
        ws.data.graph = graph;
        sendFrame(ws, ws.data, JSON.stringify(graph.value), "task graph");
        void graph.start(async (call) => {
          if (call.kind !== "value") return;
          sendFrame(ws, ws.data, JSON.stringify(call.value), "task graph update");
        });
      }
    } catch (error) {
      console.error("[hearth] stream attach failed", error);
      ws.close();
    }
  },
  message() {
    // The wire is server-push only; clients never send.
  },
  drain(ws) {
    if (ws.data.paused) {
      console.log("[hearth] stream drained; resuming");
      ws.data.paused = false;
      ws.data.pausedSince = undefined;
    }
  },
  close(ws) {
    ws.data.lost = true;
    if (ws.data.peer) streamLimiter.release(ws.data.peer);
    if (ws.data.keepalive) {
      clearInterval(ws.data.keepalive);
      ws.data.keepalive = undefined;
    }
    const watch = ws.data.watch;
    if (watch) void watch.stop();
    const graph = ws.data.graph;
    if (graph) void graph.stop();
  },
});

export type UpgradeRouteResult =
  | { handled: false }
  | { handled: true; response: Response | undefined };

export const handleWebSocketUpgradeRoutes = async (
  ctx: RouteContext,
  server: Server<WsData>
): Promise<UpgradeRouteResult> => {
  const { request, path, runtime } = ctx;
  const { deps, streamLimiter, logRefusal } = runtime;

  const eventsMatch = /^\/conversations\/([^/]+)\/events$/.exec(path);
  if (eventsMatch && request.method === "GET") {
    if (request.headers.get("origin") !== null) return { handled: true, response: forbiddenOrigin() };
    const conversationId = idOf<ConversationId>(decodeSegment(eventsMatch[1]));
    if (!conversationId) return { handled: true, response: badRequest("invalid conversation id") };
    if (!(await deps.harness.conversation(conversationId, context))) {
      return { handled: true, response: notFound(`there is no conversation ${conversationId}`) };
    }
    const peer = server.requestIP(request)?.address ?? "unknown";
    const verdict = streamLimiter.admit(peer);
    if (verdict !== "ok") {
      logRefusal(peer, verdict);
      return { handled: true, response: streamRefusal(verdict) };
    }
    if (server.upgrade(request, { data: { conversationId, peer } })) {
      return { handled: true, response: undefined };
    }
    streamLimiter.release(peer);
    return { handled: true, response: badRequest("websocket upgrade failed") };
  }

  if (request.method === "GET" && path === "/tasks/stream") {
    if (request.headers.get("origin") !== null) return { handled: true, response: forbiddenOrigin() };
    const peer = server.requestIP(request)?.address ?? "unknown";
    const verdict = streamLimiter.admit(peer);
    if (verdict !== "ok") {
      logRefusal(peer, verdict);
      return { handled: true, response: streamRefusal(verdict) };
    }
    if (server.upgrade(request, { data: { tasks: true, peer } })) {
      return { handled: true, response: undefined };
    }
    streamLimiter.release(peer);
    return { handled: true, response: badRequest("websocket upgrade failed") };
  }

  return { handled: false };
};
