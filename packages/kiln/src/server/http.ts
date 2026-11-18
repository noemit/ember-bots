import { createHash, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  LiveDoc,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";

export const serverContext: Context = BACKGROUND_CONTEXT;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * A refusal the caller can read: `status` is the wire code, `message` is the sentence a client
 * shows. Routes throw it from wherever the bad input is noticed, and the `error()` handler turns
 * it into JSON. Nothing a client sends may reach an uncaught throw: that path answers with Bun's
 * HTML error page, which carries the install path, the dependency layout and stack frames, and
 * which a JSON client cannot parse at all. "All bodies are JSON" has to hold exactly when the
 * client is confused, because that is when it reads the body.
 */
export class HttpFailure extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 405 | 409 | 413,
    message: string
  ) {
    super(message);
    this.name = "HttpFailure";
  }
}

export const DEFAULT_BODY_MAX_BYTES = 1_048_576;
export const LARGE_BODY_MAX_BYTES = 32 * 1024 * 1024;
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

export const badRequest = (message: string): Response => json({ error: message }, 400);

export const forbiddenOrigin = (): Response =>
  json(
    {
      error:
        "Kiln refused a browser request carrying an Origin header. Connect through the Ember desktop app or your private remote-access address instead.",
    },
    403
  );

/** A 404 has to name what is missing: "not found" cannot tell a wrong route from a wrong id. */
export const notFound = (message: string): Response => json({ error: message }, 404);

/** Bound a caller-supplied string before echoing it back, so one bad request is not a long body. */
export const brief = (value: string, limit = 60): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

/**
 * How long `POST /abort` waits for a run to actually wind down. Any longer and the caller is
 * told "stopping" while the abort finishes in the background, so a wedged step cannot make the
 * stop button hang. `withAbortRace` keeps the common case well under this.
 */
export const ABORT_FAST_RETURN_MS = 250;

const bodyTooLargeMessage = (maxBytes: number): string => {
  const limitLabel =
    maxBytes >= 1_048_576 && maxBytes % 1_048_576 === 0
      ? `${maxBytes / 1_048_576} MB`
      : `${Math.ceil(maxBytes / 1024)} KB`;
  return `Kiln refused this request because its body exceeds the ${limitLabel} limit. Send a smaller payload or fewer attachments and try again.`;
};

/**
 * The body of a JSON object request, bounded by `maxBytes` (`1 MB` by default; `32 MB` on routes
 * that carry image attachments or large prompts/context).
 */
export const readBody = async (
  request: Request,
  maxBytes = DEFAULT_BODY_MAX_BYTES
): Promise<Record<string, unknown>> => {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared.trim() !== "") {
    const declaredLength = Number(declared);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await request.body?.cancel().catch(() => {});
      throw new HttpFailure(413, bodyTooLargeMessage(maxBytes));
    }
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpFailure(413, bodyTooLargeMessage(maxBytes));
    }
    chunks.push(value);
  }
  if (total === 0) return {};
  const raw = Buffer.concat(chunks, total).toString("utf8");
  if (raw.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpFailure(400, "the request body is not JSON: send a JSON object, or no body at all");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpFailure(400, "the request body must be a JSON object");
  }
  return value as Record<string, unknown>;
};

/** Percent-decode one path segment, converting malformed escapes into a 400. */
export const decodeSegment = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpFailure(400, `"${brief(raw)}" in the path is not valid percent-encoding`);
  }
};

export const LIMIT_DEFAULT = 50;
export const LIMIT_MAX = 100;
export const PAGE_BYTE_BUDGET = 12 * 1024 * 1024;
export const SNAPSHOT_ROWS = LIMIT_MAX;
export const SNAPSHOT_BYTE_BUDGET = PAGE_BYTE_BUDGET;

export const pageLimit = (raw: string | null): number => {
  if (raw === null) return LIMIT_DEFAULT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > LIMIT_MAX) {
    throw new HttpFailure(400, `limit must be a whole number from 1 to ${LIMIT_MAX}; "${brief(raw)}" is not`);
  }
  return value;
};

export const parseCursor = (raw: string | null): Cursor | undefined => {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpFailure(400, "cursor is not JSON: send back the `next` object a page returned");
  }
  const after = parsed && typeof parsed === "object" ? (parsed as { after?: unknown }).after : undefined;
  if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 1) {
    throw new HttpFailure(400, "cursor must be the `next` object a page returned, with a whole-number `after`");
  }
  return parsed as Cursor;
};

export const string = (value: unknown, limit = 100_000): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;

/** True when the path exists and is a directory; false for a missing path or a file. */
export const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export const isWithinRoot = (candidate: string, root: string): boolean => {
  if (candidate === root) return true;
  const withSlash = root.endsWith("/") || root.endsWith("\\") ? root : `${root}/`;
  const withBackslash = root.endsWith("/") || root.endsWith("\\") ? root : `${root}\\`;
  return candidate.startsWith(withSlash) || candidate.startsWith(withBackslash);
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Constant-time token check: everything (including /health) requires an Authorization: Bearer header. */
export const authorized = (request: Request, token: string): boolean => {
  const header = request.headers.get("authorization");
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return presented.length > 0 && timingSafeEqual(a, b);
};

/** Every conversation record, scanned page by page from storage. */
export const allConversations = async (storage: Storage): Promise<ConversationRecord[]> => {
  const records: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await storage.scanConversations({}, 200, cursor, serverContext);
    records.push(...page.items);
    if (!page.next) return records;
    cursor = page.next;
  }
};

/** True while any conversation has a running turn (`pi.live.run`); a self-restart waits for idle. */
export const anyConversationBusy = async (harness: Harness, storage: Storage): Promise<boolean> => {
  for (const record of await allConversations(storage)) {
    const live = await harness.snapshot(LiveDoc, record.id, serverContext);
    if (live?.run) return true;
  }
  return false;
};

/** Conversation, entry and submission ids are numeric on the wire; null when malformed. */
export const idOf = <T,>(raw: string): T | null => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? (value as unknown as T) : null;
};

const ROUTE_METHODS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^\/alignment$/, ["GET"]],
  [/^\/alignment\/(connections|import|share)$/, ["POST"]],
  [/^\/settings\/compaction$/, ["GET", "PUT"]],
  [/^\/health$/, ["GET"]],
  [/^\/admin\/restart$/, ["POST"]],
  [/^\/models$/, ["GET"]],
  [/^\/models\/refresh$/, ["POST"]],
  [/^\/usage$/, ["GET"]],
  [/^\/custom-providers$/, ["GET", "POST"]],
  [/^\/custom-providers\/discover$/, ["POST"]],
  [/^\/custom-providers\/[^/]+$/, ["PUT", "DELETE"]],
  [/^\/local-runtimes\/ollama$/, ["GET", "PUT", "DELETE"]],
  [/^\/providers$/, ["GET"]],
  [/^\/providers\/import$/, ["POST"]],
  [/^\/providers\/[^/]+\/login$/, ["GET", "POST", "DELETE"]],
  [/^\/providers\/[^/]+$/, ["POST", "DELETE"]],
  [/^\/providers\/[^/]+\/login\/answer$/, ["POST"]],
  [/^\/directories$/, ["GET", "POST"]],
  [/^\/directory$/, ["GET"]],
  [/^\/directory\/peers$/, ["GET", "PUT"]],
  [/^\/directory\/send$/, ["POST"]],
  [/^\/queue$/, ["GET"]],
  [/^\/context-rules$/, ["GET", "POST"]],
  [/^\/context-rules\/[^/]+$/, ["PATCH", "DELETE"]],
  [/^\/scheduled-tasks$/, ["GET", "POST"]],
  [/^\/scheduled-tasks\/[^/]+\/run$/, ["POST"]],
  [/^\/scheduled-tasks\/[^/]+$/, ["PATCH", "DELETE"]],
  [/^\/conversations$/, ["GET", "POST"]],
  [/^\/conversations\/[^/]+$/, ["GET", "PATCH"]],
  [/^\/conversations\/[^/]+\/events$/, ["GET"]],
  [/^\/tasks\/stream$/, ["GET"]],
  [/^\/approvals$/, ["GET"]],
  [/^\/approvals\/[^/]+\/[^/]+\/reply$/, ["POST"]],
  [/^\/approvals\/[^/]+\/[^/]+\/preview$/, ["POST"]],
  [/^\/conversations\/[^/]+\/permission-rules$/, ["GET", "DELETE"]],
  [/^\/conversations\/[^/]+\/permission-rules\/[^/]+$/, ["DELETE"]],
  [/^\/questions$/, ["GET"]],
  [/^\/questions\/[^/]+\/[^/]+\/(reply|withdraw|resume|context)$/, ["POST"]],
];

const CONVERSATION_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  entries: ["GET"],
  submit: ["POST"],
  abort: ["POST"],
  compact: ["POST"],
  "queue/order": ["PUT"],
  fork: ["POST"],
  btw: ["POST"],
  promote: ["POST"],
  reset: ["POST"],
  configure: ["POST"],
  "auto-accept": ["PUT", "POST"],
  events: ["GET"],
  processes: ["GET"],
  "processes/stop": ["POST"],
  "documents/resolve": ["POST"],
  "documents/read": ["POST"],
};

const methodsSpoken = (methods: readonly string[]): string =>
  methods.length === 1 ? methods[0]! : `${methods.slice(0, -1).join(", ")} and ${methods.at(-1)}`;

export const noRoute = (method: string, path: string, methods: readonly string[] | undefined): Response =>
  json(
    methods === undefined
      ? { error: `no route of this host matches ${method} ${brief(path, 120)}; the README's wire table lists every one` }
      : { error: `${brief(path, 120)} answers only ${methodsSpoken(methods)}, not ${method}` },
    404
  );

export const routeMethods = (path: string): readonly string[] | undefined =>
  ROUTE_METHODS.find(([pattern]) => pattern.test(path))?.[1];

export const noConversationAction = (
  conversationId: ConversationId,
  method: string,
  action: string
): Response => {
  const methods =
    CONVERSATION_ACTIONS[action] ?? (/^submissions\/[^/]+\/abort$/.test(action) ? ["POST"] : undefined);
  return noRoute(method, `/conversations/${conversationId}/${brief(action, 80)}`, methods);
};
