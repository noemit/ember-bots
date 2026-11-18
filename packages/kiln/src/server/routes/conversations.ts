import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { listPermissionRules, revokePermissionRules } from "../../approvals";
import { archiveCrew, unarchiveCrew } from "../../crew";
import { MAX_RESOLVE_CANDIDATES, readConversationDocument, resolveConversationDocuments } from "../../documents";
import { MetaDoc } from "../../meta";
import {
  allConversations,
  badRequest,
  brief,
  decodeSegment,
  HttpFailure,
  idOf,
  isDirectory,
  json,
  noConversationAction,
  noRoute,
  notFound,
  PAGE_BYTE_BUDGET,
  pageLimit,
  parseCursor,
  readBody,
  routeMethods,
  serverContext,
  sleep,
  SNAPSHOT_BYTE_BUDGET,
  SNAPSHOT_ROWS,
  string,
} from "../http";
import {
  byLastEntry,
  documentsOf,
  fitToBudget,
  imageOfEntry,
  imageRefsOf,
  imagesInEntry,
  parseAgentChange,
  summaryOf,
  type EntryShape,
} from "../summary";
import type { RouteContext } from "../types";
import { handleConversationAction } from "./conversationActions";

const context = serverContext;

export const handleConversationRoutes = async (ctx: RouteContext): Promise<Response | null> => {
  const { request, url, path, runtime } = ctx;
  const { deps, scan, memory } = runtime;
  const { config, storage, harness } = deps;

  if (path === "/conversations") {
    if (request.method === "GET") {
      const records = await allConversations(storage);
      const leftovers = scan().byConversation;
      const summaries = await Promise.all(
        records.map((record) => summaryOf(harness, record, storage, leftovers.get(record.id as number)))
      );
      summaries.sort(byLastEntry);
      return json({ conversations: summaries, host: { memory: memory() } });
    }
    if (request.method === "POST") {
      const body = await readBody(request);
      const change = parseAgentChange(body);
      if (change?.cwd && !isDirectory(change.cwd)) {
        return badRequest(`folder does not exist: ${change.cwd}`);
      }
      const conversation = await harness.createConversation(
        { ownership: { kind: "ownerless" }, ...(change ? { agent: change } : {}) },
        context
      );
      const title = string(body.title, 500);
      const delegates = body.delegates === false ? false : true;
      await harness.commit(async (tx) => {
        const doc = await tx.doc(MetaDoc, conversation.id);
        if (title) doc.title = title;
        doc.delegates = delegates;
      }, context);
      return json(await summaryOf(harness, { id: conversation.id }, storage), 201);
    }
    return noRoute(request.method, path, routeMethods(path));
  }

  const permissionRules = /^\/conversations\/([^/]+)\/permission-rules(?:\/([^/]+))?$/.exec(path);
  if (permissionRules && (request.method === "GET" || request.method === "DELETE")) {
    const id = idOf<ConversationId>(decodeSegment(permissionRules[1]));
    if (!id) return badRequest("invalid conversation id");
    if (!(await harness.conversation(id, context))) {
      return notFound("Kiln could not find this conversation. Refresh the session list.");
    }
    if (request.method === "GET" && !permissionRules[2]) {
      return json({ rules: await listPermissionRules(harness, id, context) });
    }
    if (request.method === "DELETE") {
      await revokePermissionRules(harness, id, permissionRules[2] ? decodeSegment(permissionRules[2]) : undefined, context);
      return json({ ok: true });
    }
  }

  const conversationMatch = /^\/conversations\/([^/]+)(\/.*)?$/.exec(path);
  if (!conversationMatch) return null;

  const conversationId = idOf<ConversationId>(decodeSegment(conversationMatch[1]));
  if (!conversationId) return badRequest("invalid conversation id");
  const conversation = await harness.conversation(conversationId, context);
  if (!conversation) return notFound(`there is no conversation ${conversationId}`);
  const action = (conversationMatch[2] ?? "").replace(/^\//, "");

  if (!action && request.method === "GET") {
    const cursor = parseCursor(url.searchParams.get("cursor"));
    const [page, record, docs] = await Promise.all([
      conversation.entries({}, SNAPSHOT_ROWS, cursor, context),
      storage.conversation(conversationId, context),
      documentsOf(harness, conversationId),
    ]);
    if (!record) return notFound(`there is no conversation ${conversationId}`);
    const fitted = fitToBudget(page.items, SNAPSHOT_BYTE_BUDGET);
    const next = fitted.next ?? page.next;
    const chronological = [...fitted.items].reverse();
    const entries =
      url.searchParams.get("images") === "ref"
        ? chronological.map((entry) => imageRefsOf(entry as EntryShape))
        : chronological;
    return json({ conversation: record, entries, docs, ...(next ? { next } : {}) });
  }

  if (!action && request.method === "PATCH") {
    const body = await readBody(request);
    const hasTitle = body.title !== undefined;
    const title = !hasTitle ? undefined : body.title === null ? null : string(body.title, 500) ?? null;
    if (hasTitle && body.title !== null && title === null) return badRequest("invalid title");
    const archived = body.archived === null ? null : typeof body.archived === "number" ? body.archived : undefined;
    if (body.archived !== undefined && body.archived !== null && archived === undefined) {
      return badRequest("invalid archived");
    }
    if (!hasTitle && archived === undefined) return badRequest("nothing to change");
    if (archived === undefined) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(MetaDoc, conversationId);
        if (title === null) delete doc.title;
        else if (title !== undefined) doc.title = title;
      }, context);
    } else if (archived === null) {
      await unarchiveCrew(harness, conversationId, title, context);
    } else {
      await archiveCrew(harness, conversationId, archived, title, context);
    }
    return json(await summaryOf(harness, { id: conversationId }, storage));
  }

  if (action === "processes" && request.method === "GET") {
    const fresh = scan({ fresh: true });
    return json({
      host: { memory: memory() },
      processes: fresh.byConversation.get(conversationId as number) ?? [],
    });
  }

  if (action === "processes/stop" && request.method === "POST") {
    const body = await readBody(request);
    const requested: number[] = [];
    if (body.pids !== undefined && !Array.isArray(body.pids)) {
      return badRequest("pids must be a list of process ids, as numbers");
    }
    for (const value of Array.isArray(body.pids) ? body.pids : []) {
      const pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        return badRequest("pids must be a list of process ids, as numbers");
      }
      requested.push(pid);
    }
    if (requested.length === 0) {
      return badRequest("nothing to stop: send pids, the ids from this conversation's processes list");
    }
    if (requested.length > 64) return badRequest("too many processes at once: send at most 64 ids");
    const force = body.force === true;
    const mine = new Map(
      (scan({ fresh: true }).byConversation.get(conversationId as number) ?? []).map((entry) => [entry.pid, entry])
    );
    const running = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const results: Array<{ pid: number; command?: string; outcome: "stopped" | "gone" | "refused" }> = [];
    for (const pid of requested) {
      const entry = mine.get(pid);
      if (entry === undefined || pid <= 1 || pid === process.pid) {
        results.push({ pid, outcome: running(pid) ? "refused" : "gone" });
        continue;
      }
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        results.push({ pid, command: entry.command, outcome: "gone" });
        continue;
      }
      const deadline = Date.now() + (force ? 500 : 1_500);
      while (Date.now() < deadline && running(pid)) await sleep(100);
      results.push({
        pid,
        command: entry.command,
        outcome: running(pid) ? "refused" : "stopped",
      });
    }
    const after = scan({ fresh: true });
    return json({
      results,
      host: { memory: memory() },
      processes: after.byConversation.get(conversationId as number) ?? [],
    });
  }

  if (action === "entries" && request.method === "GET") {
    const limit = pageLimit(url.searchParams.get("limit"));
    const cursor = parseCursor(url.searchParams.get("cursor"));
    let minEntryId: EntryId | undefined;
    const rawSince = url.searchParams.get("since");
    if (rawSince !== null) {
      const since = Number(rawSince);
      const lowerBound = Number.isSafeInteger(since) && since >= 0 ? idOf<EntryId>(String(since + 1)) : null;
      if (lowerBound === null) {
        throw new HttpFailure(400, `since must be a whole entry id, 0 or greater; "${brief(rawSince)}" is not`);
      }
      minEntryId = lowerBound;
    }
    const page = await conversation.entries(minEntryId === undefined ? {} : { minEntryId }, limit, cursor, context);
    const fitted = fitToBudget(page.items, PAGE_BYTE_BUDGET);
    const pageItems = fitted.items;
    const pageNext = fitted.next ?? page.next;
    const wantDocs = url.searchParams.get("docs");
    const items =
      url.searchParams.get("images") === "ref" ? pageItems.map((entry) => imageRefsOf(entry as EntryShape)) : pageItems;
    if (wantDocs === "1" || wantDocs === "true") {
      return json({ entries: items, next: pageNext, docs: await documentsOf(harness, conversationId) });
    }
    return json({ entries: items, next: pageNext });
  }

  const imageMatch = /^entries\/(\d+)\/images\/(\d+)$/.exec(action);
  if (imageMatch && request.method === "GET") {
    const entryId = idOf<EntryId>(imageMatch[1]);
    const wanted = Number(imageMatch[2]);
    if (!entryId) return badRequest("invalid entry id");
    if (!Number.isSafeInteger(wanted) || wanted < 0) return badRequest("invalid image index");
    const page = await conversation.entries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, context);
    const entry = page.items[0];
    if (!entry) return notFound(`conversation ${conversationId} has no entry ${entryId}`);
    const image = imageOfEntry(entry as EntryShape, wanted);
    if (!image) {
      return notFound(`entry ${entryId} has no image ${wanted}; it carries ${imagesInEntry(entry as EntryShape)}`);
    }
    return new Response(image.bytes, {
      headers: { "content-type": image.mimeType, "cache-control": "private, max-age=3600" },
    });
  }

  const actionResponse = await handleConversationAction(ctx, conversationId, conversation, action);
  if (actionResponse !== null) return actionResponse;

  if (action === "documents/resolve" && request.method === "POST") {
    const body = await readBody(request);
    if (!Array.isArray(body.candidates)) {
      return badRequest("candidates must be a list of document paths or filenames");
    }
    if (body.candidates.length > MAX_RESOLVE_CANDIDATES) {
      return badRequest(`too many document candidates: send at most ${MAX_RESOLVE_CANDIDATES} per request`);
    }
    if (body.candidates.some((item) => typeof item !== "string")) {
      return badRequest("each document candidate must be a string");
    }
    if (body.basePath !== undefined && typeof body.basePath !== "string") {
      return badRequest("basePath must be a string path");
    }
    const result = await resolveConversationDocuments(
      { storage, harness, configHome: config.home },
      conversationId,
      {
        candidates: body.candidates,
        ...(typeof body.basePath === "string" ? { basePath: body.basePath } : {}),
      },
      context
    );
    if (!result.ok) {
      return json({ error: result.error }, result.status);
    }
    return json({ resolved: result.resolved });
  }

  if (action === "documents/read" && request.method === "POST") {
    const body = await readBody(request);
    if (typeof body.path !== "string" || !body.path.trim()) {
      return badRequest("path is required to read a conversation document");
    }
    if (body.basePath !== undefined && typeof body.basePath !== "string") {
      return badRequest("basePath must be a string path");
    }
    const result = await readConversationDocument(
      { storage, harness, configHome: config.home },
      conversationId,
      {
        path: body.path,
        ...(typeof body.basePath === "string" ? { basePath: body.basePath } : {}),
      },
      context
    );
    if (!result.ok) {
      return json({ error: result.error }, result.status);
    }
    return json(result.document);
  }

  return noConversationAction(conversationId, request.method, action);
};
