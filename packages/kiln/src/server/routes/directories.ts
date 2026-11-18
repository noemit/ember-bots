import { mkdirSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import {
  AgentsDoc,
  formatForeignAgentMessage,
  listAgents,
  mergeDirectory,
  pruneStaleAgents,
  staleAgentNames,
  writeAgentsMirror,
  writePeersMirror,
  type DirectorySummary,
  type PeerEndpoint,
} from "../../agents";
import { mergePeers, portablePeer } from "../../alignment";
import { MetaDoc } from "../../meta";
import { StopQueueDoc, resumeStopQueueHandoff, settleStopStateOnInputInTx } from "../../stopQueueHandoff";
import {
  allConversations,
  badRequest,
  brief,
  isWithinRoot,
  json,
  noRoute,
  notFound,
  readBody,
  routeMethods,
  serverContext,
  string,
} from "../http";
import { busyRefusal, summaryOf } from "../summary";
import type { RouteContext } from "../types";

const context = serverContext;

export const handleDirectoryRoutes = async (ctx: RouteContext): Promise<Response | null> => {
  const { request, url, path, runtime } = ctx;
  const { config, storage, harness } = runtime.deps;

  if (request.method === "POST" && path === "/directories") {
    const input = (await readBody(request)) as { parent?: unknown; name?: unknown };
    if (typeof input.parent !== "string" || !input.parent.trim() || typeof input.name !== "string") {
      return badRequest("Choose a parent folder and a name.");
    }
    const name = input.name.trim();
    if (!name || name === "." || name === ".." || name.length > 255 || /[\\/<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
      return badRequest("Use a folder name without slashes or special characters.");
    }
    const computerScope = url.searchParams.get("scope") === "computer";
    const configuredRoot = resolve(config.workspace);
    let parent = resolve(input.parent);
    if (!computerScope) {
      let root: string;
      try {
        root = realpathSync(configuredRoot);
      } catch {
        return badRequest("Choose a folder inside the workspace.");
      }
      let canonicalParent: string;
      try {
        canonicalParent = realpathSync(parent);
      } catch {
        if (!isWithinRoot(parent, root) && !isWithinRoot(parent, configuredRoot)) {
          return badRequest("Choose a folder inside the workspace.");
        }
        return badRequest("Kiln could not create that folder. Choose another name or check access to the parent folder.");
      }
      if (!isWithinRoot(canonicalParent, root)) {
        return badRequest("Choose a folder inside the workspace.");
      }
      parent = canonicalParent;
    }
    try {
      const directory = join(parent, name);
      mkdirSync(directory);
      return json({ path: directory }, 201);
    } catch {
      return badRequest("Kiln could not create that folder. Choose another name or check access to the parent folder.");
    }
  }

  if (request.method === "GET" && path === "/directories") {
    const computerScope = url.searchParams.get("scope") === "computer";
    const configuredRoot = resolve(config.workspace);
    let root = configuredRoot;
    if (!computerScope) {
      try {
        root = realpathSync(configuredRoot);
      } catch {
        return badRequest("not a directory");
      }
    }
    const requested = url.searchParams.get("path");
    let target = resolve(requested && requested.trim() ? requested : root);
    if (!computerScope) {
      let canonicalTarget: string;
      try {
        canonicalTarget = realpathSync(target);
      } catch {
        if (!isWithinRoot(target, root) && !isWithinRoot(target, configuredRoot)) {
          return badRequest("path is outside the workspace");
        }
        return badRequest("not a directory");
      }
      if (!isWithinRoot(canonicalTarget, root)) {
        return badRequest("path is outside the workspace");
      }
      target = canonicalTarget;
    }
    const allowedDirectoryEntry = (dir: string, entry: Dirent): boolean => {
      if (entry.name.startsWith(".") || entry.name === "node_modules") return false;
      const child = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          if (!statSync(child).isDirectory()) return false;
          if (!computerScope && !isWithinRoot(realpathSync(child), root)) return false;
          return true;
        } catch {
          return false;
        }
      }
      if (!entry.isDirectory()) return false;
      if (!computerScope) {
        try {
          if (!isWithinRoot(realpathSync(child), root)) return false;
        } catch {
          return false;
        }
      }
      return true;
    };
    const visible = (dir: string): string[] => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => allowedDirectoryEntry(dir, entry))
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    };
    let directories: Array<{ name: string; path: string; hasChildren: boolean }>;
    try {
      directories = readdirSync(target, { withFileTypes: true })
        .filter((entry) => allowedDirectoryEntry(target, entry))
        .map((entry) => {
          const child = join(target, entry.name);
          return { name: entry.name, path: child, hasChildren: visible(child).length > 0 };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 500);
    } catch {
      return badRequest("not a directory");
    }
    return json({ workspace: root, path: target, directories });
  }

  if (request.method === "GET" && path === "/directory") {
    const entries = listAgents(await harness.snapshot(AgentsDoc, context));
    const summaries = new Map<number, DirectorySummary>();
    for (const entry of entries) {
      if (summaries.has(entry.conversationId)) continue;
      const id = entry.conversationId as ConversationId;
      if (!(await harness.conversation(id, context))) continue;
      summaries.set(entry.conversationId, await summaryOf(harness, { id }, storage));
    }
    const stale = staleAgentNames(entries, summaries);
    if (stale.length > 0) {
      const removed = await harness.commit((tx) => pruneStaleAgents(tx, stale), context);
      if (removed > 0) {
        writeAgentsMirror(config.home, await harness.snapshot(AgentsDoc, context));
      }
    }
    return json({ agents: mergeDirectory(entries, summaries) });
  }

  if (path === "/directory/peers") {
    if (request.method === "GET") {
      const state = await harness.snapshot(AgentsDoc, context);
      return json({
        peers: (state?.peers ?? []).map((p) => ({ id: p.id, label: p.label, url: p.url })),
      });
    }
    if (request.method === "PUT") {
      const body = await readBody(request);
      if (!Array.isArray(body.peers) || body.peers.length > 100) {
        return badRequest("Kiln could not update peer connections. Choose up to 100 connections and try again.");
      }
      const validated = body.peers.map(portablePeer);
      if (validated.some((peer) => !peer)) {
        return badRequest(
          "Kiln could not save those peer connections. Use private-network or HTTPS addresses reachable from another computer, with a connection token, then try again."
        );
      }
      const peers = validated as PeerEndpoint[];
      let stored: PeerEndpoint[] = [];
      await harness.commit(async (tx) => {
        const doc = await tx.doc(AgentsDoc);
        stored = body.merge === true ? mergePeers(doc.peers ?? [], peers) : mergePeers([], peers);
        doc.peers = stored;
      }, context);
      writePeersMirror(config.home, stored);
      return json({ ok: true, count: stored.length });
    }
    return noRoute(request.method, path, routeMethods(path));
  }

  if (path === "/directory/send") {
    if (request.method !== "POST") return noRoute(request.method, path, routeMethods(path));
    const body = await readBody(request);
    const name = string(body.name, 200)?.trim();
    const message = string(body.message, 50_000)?.trim();
    if (!name) return badRequest("name is required");
    if (!message) return badRequest("message is required");
    const followUp = body.followUp === true;
    const senderHost = string(body.senderHost, 120)?.trim() || "remote";
    const senderName = string(body.senderName, 200)?.trim() || "agent";
    const requestId = string(body.requestId, 200)?.trim();

    const state = await harness.snapshot(AgentsDoc, context);
    const wanted = name.toLowerCase();
    const regEntry =
      state && Object.hasOwn(state.entries, name)
        ? state.entries[name]
        : state
          ? Object.entries(state.entries).find(([k]) => k.toLowerCase() === wanted)?.[1]
          : undefined;

    let targetId: ConversationId | undefined = regEntry ? (regEntry.conversationId as ConversationId) : undefined;
    let resolvedLabel = name;

    if (targetId === undefined) {
      const records = await allConversations(storage);
      const titleMatches: Array<{ id: ConversationId; title: string }> = [];
      for (const rec of records) {
        const meta = await harness.snapshot(MetaDoc, rec.id, context);
        if (!meta || meta.archived || meta.kind === "worker") continue;
        const title = meta.title?.trim();
        if (title && title.toLowerCase() === wanted) {
          titleMatches.push({ id: rec.id, title });
        }
      }
      if (titleMatches.length > 1) {
        return json(
          {
            error: `More than one conversation on this host is titled "${name}" (${titleMatches.map((m) => m.id).join(", ")}).`,
          },
          409
        );
      }
      if (titleMatches.length === 1) {
        targetId = titleMatches[0].id;
        resolvedLabel = titleMatches[0].title;
      }
    }

    if (targetId === undefined) {
      return notFound(`no agent named "${brief(name, 100)}" on this host`);
    }
    const handle = await harness.conversation(targetId, context);
    if (!handle) {
      return notFound(`agent "${brief(name, 100)}" conversation ${targetId} is gone`);
    }
    const content = formatForeignAgentMessage(senderHost, senderName, message);
    const draft = {
      type: "input" as const,
      content,
      whenBusy: followUp ? ("followUp" as const) : ("steer" as const),
      ...(requestId ? { requestId } : {}),
    };
    const finishHandoff = new Error("Finish the pending stop before admitting an idle input");
    const admit = () =>
      harness.commit(async (tx) => {
        const prior = draft.requestId === undefined ? undefined : await tx.submissionByRequest(targetId, draft.requestId);
        const stopQueue = await tx.doc(StopQueueDoc, targetId);
        const meta = await tx.doc(MetaDoc, targetId);
        const liveBefore = await tx.doc(LiveDoc, targetId);
        const wasBusy = liveBefore.run !== undefined;
        const wasFailed = Boolean(liveBefore.runFailure);
        if (!prior && stopQueue.pending && !wasBusy && meta.stoppedAt === stopQueue.pending.stoppedAt) {
          throw finishHandoff;
        }
        const submissionId = await handle.submit(tx, draft);
        if (!prior) {
          await settleStopStateOnInputInTx(tx, targetId, {
            submissionId,
            wasBusy,
            wasFailed,
          });
        }
        return submissionId;
      }, context);
    try {
      await admit();
    } catch (error) {
      if (error !== finishHandoff) throw error;
      await resumeStopQueueHandoff(harness, targetId, context);
      try {
        await admit();
      } catch (retryError) {
        if (retryError === finishHandoff) return busyRefusal(targetId);
        throw retryError;
      }
    }
    return json({ ok: true, name: resolvedLabel, conversationId: targetId }, 201);
  }

  return null;
};
