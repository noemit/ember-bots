import { badRequest, HttpFailure, json, readBody } from "../http";
import type { RouteContext } from "../types";

export const handleAdminRoutes = async (ctx: RouteContext): Promise<Response | null> => {
  const { request, path, runtime } = ctx;
  const { deps, scan, memory } = runtime;
  const { version, build, restart } = deps;

  if (request.method === "GET" && path === "/health") {
    const usage = process.memoryUsage();
    const host = memory();
    return json({
      ok: true,
      service: "hearth",
      version: version ?? "0.0.0",
      ...(build ? { commit: build } : {}),
      memory: {
        ...host,
        rssBytes: usage.rss,
        heapUsedBytes: usage.heapUsed,
        leftRunning: scan().all.length,
      },
    });
  }

  if (request.method === "POST" && path === "/admin/restart") {
    if (!restart) return badRequest("restart is not supported on this host");
    const body = (await readBody(request)) as { reason?: unknown };
    const reason =
      typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : "requested";
    restart(reason);
    return json({
      ok: true,
      restarting: true,
      reason,
      version: version ?? "0.0.0",
      ...(build ? { commit: build } : {}),
    });
  }

  if (path === "/settings/compaction") {
    const settings = deps.compactionSettings;
    if (!settings) {
      return badRequest("This Kiln cannot configure compaction yet. Update Kiln, then reopen these settings.");
    }
    if (request.method === "GET") return json(settings.state());
    if (request.method === "PUT") {
      const body = await readBody(request);
      try {
        return json(settings.save(body.preference));
      } catch (error) {
        return badRequest(
          `Kiln could not save compaction settings. ${error instanceof Error ? error.message : "Check the token counts, then try Save again."}`
        );
      }
    }
  }

  if (path === "/local-runtimes/ollama") {
    const settings = deps.ollamaSettings;
    if (!settings) return badRequest("This Kiln cannot set up Ollama yet. Update Kiln, then Test / Refresh again.");
    try {
      if (request.method === "GET") return json(settings.state());
      if (request.method === "PUT") return json(await settings.save((await readBody(request)).baseUrl));
      if (request.method === "DELETE") return json(await settings.save(undefined, true));
    } catch (error) {
      if (error instanceof HttpFailure) throw error;
      return badRequest(
        "Kiln could not save the Ollama address. Use a complete HTTP or HTTPS service address without credentials or an API path, then Test / Refresh again."
      );
    }
  }

  return null;
};
