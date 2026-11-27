import { createHmac } from "node:crypto";
import type { Credential } from "@earendil-works/pi-ai";
import { attachCurrentContextTracking } from "./currentContext";
import { createLoginSupervisor, type LoginProvider } from "./login";
import { refreshLiveCatalog } from "./models";
import { hostMemory, scanLeftovers } from "./processes";
import { attachQueueConfigTracking } from "./queueConfig";
import { createStreamLimiter } from "./streamLimit";
import {
  anyConversationBusy,
  authorized,
  DEFAULT_BODY_MAX_BYTES,
  forbiddenOrigin,
  HttpFailure,
  json,
  LARGE_BODY_MAX_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  noRoute,
  routeMethods,
  serverContext,
} from "./server/http";
import { handleAdminRoutes } from "./server/routes/admin";
import { handleConversationRoutes } from "./server/routes/conversations";
import { handleDirectoryRoutes } from "./server/routes/directories";
import { handlePromptRoutes } from "./server/routes/prompts";
import { handleProviderRoutes } from "./server/routes/providers";
import { handleTaskRoutes } from "./server/routes/tasks";
import type { HearthServer, RouteContext, ServerDeps, ServerRuntime, WsData } from "./server/types";
import {
  createRefusalLogger,
  createWebSocketHandler,
  handleWebSocketUpgradeRoutes,
} from "./server/websocket";

export {
  anyConversationBusy,
  DEFAULT_BODY_MAX_BYTES,
  HttpFailure,
  LARGE_BODY_MAX_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  type HearthServer,
};

/** Start the Hearth wire: authenticated HTTP for lists and actions, WebSockets for streams. */
export const startHearthServer = (deps: ServerDeps): HearthServer => {
  const { config, token, harness, models, store, localRuntimes } = deps;
  const context = serverContext;
  const contextTracking = attachCurrentContextTracking(harness, context);
  const queueConfigTracking = attachQueueConfigTracking(harness, context);
  const scan = deps.processes?.scan ?? scanLeftovers;
  const memory = deps.processes?.memory ?? hostMemory;

  let refreshInFlight: Promise<{ errors: string[] }> | undefined;

  const runLiveModelRefresh = (providers?: readonly string[], signal?: AbortSignal): Promise<{ errors: string[] }> => {
    if (!providers && !signal && refreshInFlight) return refreshInFlight;
    const run = refreshLiveCatalog({
      models,
      ...(store ? { store } : {}),
      ...(deps.ollamaSettings ? { ollamaSettings: deps.ollamaSettings } : {}),
      ...(localRuntimes ? { localRuntimes } : {}),
      ...(providers ? { providers } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!providers && !signal) {
      refreshInFlight = run.finally(() => {
        if (refreshInFlight === run) refreshInFlight = undefined;
      });
      return refreshInFlight;
    }
    return run;
  };

  const refreshModelCatalog = (reason: string): void => {
    void runLiveModelRefresh()
      .then((refresh) => {
        if (refresh.errors.length > 0) {
          console.error(`[hearth] model refresh after ${reason} failed for: ${refresh.errors.join(", ")}`);
        }
      })
      .catch((error: unknown) => {
        console.error(
          `[hearth] model refresh after ${reason} failed:`,
          error instanceof Error ? error.message : error
        );
      });
  };

  const loginSupervisor = createLoginSupervisor(
    (id) => {
      const provider = models.getProviders().find((candidate) => candidate.id === id);
      if (!provider) return undefined;
      const oauth = provider.auth.oauth;
      return {
        id: provider.id,
        ...(oauth === undefined
          ? {}
          : {
              oauth: {
                loginLabel: oauth.loginLabel,
                name: oauth.name,
                login: (interaction, options) => oauth.login(interaction, options),
              },
            }),
      } satisfies LoginProvider;
    },
    async (providerId, credential) => {
      if (!store) throw new Error("this Hearth has no credential store to save it in");
      await store.modify(providerId, async () => credential as Credential);
      refreshModelCatalog(`a sign-in for ${providerId}`);
    }
  );

  const streamLimiter = createStreamLimiter();
  const logRefusal = createRefusalLogger();

  const runtime: ServerRuntime = {
    context,
    deps,
    scan,
    memory,
    runLiveModelRefresh,
    refreshModelCatalog,
    loginSupervisor,
    streamLimiter,
    logRefusal,
  };

  const server = Bun.serve<WsData>({
    port: config.port,
    hostname: config.bind,
    maxRequestBodySize: LARGE_BODY_MAX_BYTES,
    error(error) {
      if (error instanceof HttpFailure) return json({ error: error.message }, error.status);
      console.error("[hearth] request failed:", error);
      return json(
        {
          error:
            "Hearth hit an internal error answering this request and did not finish it. The conversation is unaffected: reload it, and check the host log if it keeps happening.",
        },
        500
      );
    },
    websocket: createWebSocketHandler(harness, streamLimiter),
    async fetch(request, server) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const isMutating =
        request.method === "POST" ||
        request.method === "PUT" ||
        request.method === "DELETE" ||
        request.method === "PATCH";
      const isWebSocketUpgrade =
        request.headers.get("upgrade")?.toLowerCase() === "websocket" ||
        (request.method === "GET" && (path === "/tasks/stream" || /^\/conversations\/[^/]+\/events$/.test(path)));
      if (request.headers.get("origin") !== null && (isMutating || isWebSocketUpgrade)) {
        return forbiddenOrigin();
      }
      // Unauthenticated peer-ownership challenge: proves this listener holds the private token
      // without the client transmitting the reusable bearer secret first (S3).
      if (request.method === "GET" && path === "/health/challenge") {
        const nonce = url.searchParams.get("nonce") ?? "";
        if (!/^[a-f0-9]{16,128}$/i.test(nonce)) {
          return json({ error: "invalid nonce" }, 400);
        }
        const proof = createHmac("sha256", token).update(`kiln-health:${nonce}`).digest("hex");
        return json({ service: "hearth", proof });
      }
      if (!authorized(request, token)) return json({ error: "unauthorized" }, 401);

      const ctx: RouteContext = { request, url, path, runtime };

      const admin = await handleAdminRoutes(ctx);
      if (admin !== null) return admin;

      const provider = await handleProviderRoutes(ctx);
      if (provider !== null) return provider;

      const directory = await handleDirectoryRoutes(ctx);
      if (directory !== null) return directory;

      const task = await handleTaskRoutes(ctx);
      if (task !== null) return task;

      const upgrade = await handleWebSocketUpgradeRoutes(ctx, server);
      if (upgrade.handled) return upgrade.response;

      const conversation = await handleConversationRoutes(ctx);
      if (conversation !== null) return conversation;

      const prompt = await handlePromptRoutes(ctx);
      if (prompt !== null) return prompt;

      return noRoute(request.method, path, routeMethods(path));
    },
  });

  return {
    port: server.port ?? config.port,
    url: `http://127.0.0.1:${server.port ?? config.port}`,
    close: async () => {
      await contextTracking.close();
      await queueConfigTracking.close();
      server.stop(true);
    },
  };
};
