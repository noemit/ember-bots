/**
 * Code mode for Hearth: a `codemode` tool that runs model-written JavaScript in a QuickJS
 * sandbox, a `tool_search` tool for the deferred tools it does not describe, and a `scratchpad`
 * tool over the same per-conversation document the scripts keep values in.
 *
 * The point of code mode is that one script can loop, filter, and join tool results in the VM, so
 * a hundred `read`s cost one tool result in the context instead of a hundred. The scripts are
 * durable: `@earendil-works/pi-durable/codemode` journals every nested call's result and replays
 * the script deterministically after a restart, so a run interrupted mid-script resumes instead
 * of starting over.
 *
 * Values a script keeps with `store(key, value)` live in `CodemodeStoreDoc` — `{ values }`,
 * rewindable and per conversation. `scratchpad` is a plain tool over that same document, so the
 * model can look at (or seed, or clear) what its scripts kept, without writing a script for it.
 */
import { Buffer } from "node:buffer";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
  CODEMODE_TOOL_NAME,
  CodemodeStoreDoc,
  createCodemodeExtension,
  type CodemodeNamespace,
} from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";

/** Bytes one stored value takes as JSON, or `undefined` when it is not JSON at all. */
const jsonBytes = (value: unknown): number | undefined => {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : Buffer.byteLength(json, "utf8");
  } catch {
    return undefined;
  }
};

/** A short, single-line description of a stored value: its kind and a peeking preview. */
export const describeValue = (value: unknown, maxChars = 60): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  switch (typeof value) {
    case "string": {
      const inline = JSON.stringify(value.length > maxChars ? `${value.slice(0, maxChars)}…` : value);
      return `string ${inline}`;
    }
    case "number":
    case "boolean":
      return `${typeof value} ${String(value)}`;
    case "object":
      return `object(${Object.keys(value as Record<string, unknown>).length} keys)`;
    default:
      return typeof value;
  }
};

const humanBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const SCRATCHPAD_ACTIONS = ["list", "get", "set", "delete", "clear"] as const;

export type ScratchpadAction = (typeof SCRATCHPAD_ACTIONS)[number];

const scratchpadParameters = obj({
  // Written out rather than mapped, so the literal union survives in the type the tool's `execute` sees.
  action: oneOf(
    ["list", "get", "set", "delete", "clear"],
    {
      description:
        "list: every key with its size and a short preview. get: one value as formatted JSON. " +
        "set: store `value` under `key`. delete: remove `key`. clear: remove every key.",
    }
  ),
  key: opt(str({ description: "The key, for get, set, and delete." })),
  value: opt(
    unknown({ description: "The JSON value to store, for set. Any JSON value: string, number, array, object, null." })
  ),
});

export type ScratchpadInput = {
  action: ScratchpadAction;
  key?: string;
  value?: unknown;
};

const text = (body: string, isError = false): ToolExecutionResult => ({
  output: [{ type: "text", text: body }],
  ...(isError ? { isError: true } : {}),
});

/**
 * `scratchpad`: the conversation's `CodemodeStoreDoc`, as an ordinary tool.
 *
 * It reads and writes exactly the document `codemode` scripts reach with `load(key)` and
 * `store(key, value)`, so a script can leave a filtered result behind for a later turn (or for
 * this tool) to read without spending context on it. Writes go through `api.commit`, so they are
 * durable, rewindable with the conversation, and copied as of the fork point.
 */
export const ScratchpadTool = defineTool({
  name: "scratchpad",
  description:
    "Read and write this conversation's scratchpad: the same key/value store `codemode` scripts " +
    "use with `load(key)` and `store(key, value)`. Use `list` to see what is there without " +
    "dumping the values, `get` to read one as JSON, `set` to keep a value for later, " +
    "`delete` for one key, and `clear` for all of them.",
  parameters: scratchpadParameters,
  replay: "safe",
  callers: ["model", "tools"],
  execute: async (input, api, context) => {
    const args = input as ScratchpadInput;
    const read = async (): Promise<Record<string, unknown>> => {
      const doc = await api.snapshot(CodemodeStoreDoc, api.conversationId, context);
      return (doc?.values ?? {}) as Record<string, unknown>;
    };
    const commit = async <T>(change: (values: Record<string, unknown>) => T): Promise<T> =>
      api.commit(async (tx) => {
        const doc = await tx.doc(CodemodeStoreDoc, api.conversationId);
        return change(doc.values as Record<string, unknown>);
      }, context);

    switch (args.action) {
      case "list": {
        const values = await read();
        const keys = Object.keys(values).sort();
        if (keys.length === 0) return text('The scratchpad is empty. Store a value with action "set".');
        const lines = keys.map((key) => {
          const bytes = jsonBytes(values[key]);
          const size = bytes === undefined ? "unserializable" : humanBytes(bytes);
          return `- ${key} (${size}): ${describeValue(values[key])}`;
        });
        return text([`${keys.length} key(s) in the scratchpad:`, ...lines].join("\n"));
      }
      case "get": {
        const key = args.key;
        if (key === undefined) return text('Scratchpad: action "get" needs a key.', true);
        const values = await read();
        if (!(key in values)) return text(`Scratchpad: no key "${key}". Use action "list" to see the keys.`, true);
        return text(JSON.stringify(values[key], null, 2));
      }
      case "set": {
        const key = args.key;
        if (key === undefined) return text('Scratchpad: action "set" needs a key.', true);
        if (args.value === undefined) {
          return text(`Scratchpad: action "set" needs a value (store null explicitly to keep a null).`, true);
        }
        const bytes = jsonBytes(args.value);
        if (bytes === undefined) return text(`Scratchpad: the value for "${key}" is not JSON.`, true);
        await commit((values) => {
          values[key] = args.value;
          return key;
        });
        return text(`Stored "${key}" (${bytes} bytes)`);
      }
      case "delete": {
        const key = args.key;
        if (key === undefined) return text('Scratchpad: action "delete" needs a key.', true);
        const existed = await commit((values) => {
          const had = key in values;
          delete values[key];
          return had ? "deleted" : "absent";
        });
        return text(existed === "deleted" ? `Deleted "${key}"` : `Scratchpad: no key "${key}".`);
      }
      case "clear": {
        const removed = await commit((values) => {
          const keys = Object.keys(values);
          for (const key of keys) delete values[key];
          return keys.length;
        });
        return text(removed === 0 ? "The scratchpad was already empty." : `Cleared ${removed} key(s).`);
      }
      default: {
        const unknown = (args as { action?: unknown }).action;
        return text(`Scratchpad: unknown action ${JSON.stringify(unknown)}.`, true);
      }
    }
  },
});

/** The `scratchpad` extension: one tool, no sections. */
export const Scratchpad = defineExtension({ name: "scratchpad", tools: [ScratchpadTool] });

/** Whether `env.HEARTH_CODEMODE` turns the QuickJS `codemode` tool off (`off`, `0`, `false`). */
export const codemodeEnabled = (env: Record<string, string | undefined>): boolean => {
  const raw = env.HEARTH_CODEMODE?.trim().toLowerCase();
  if (!raw) return true;
  return !["off", "0", "false"].includes(raw);
};

export type HearthCodemodeOptions = {
  /** Groups of tools by name prefix (MCP servers), for the `codemode` section and tool search. */
  namespaces?: readonly CodemodeNamespace[];
  /** Where `HEARTH_CODEMODE` is read from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
};

/**
 * The code mode extensions, in install order:
 *
 * 1. `codemode` — the QuickJS script tool and its prompt section (`HEARTH_CODEMODE=off` skips it).
 * 2. `tool-search` — the `tool_search` tool: finds the deferred tools the section leaves out, and loads them.
 * 3. `scratchpad` — the conversation's code-mode store, as a plain tool.
 *
 * `close()` releases the sandbox (in-flight scripts are aborted; each run already owns its worker).
 * Install these *before* extensions that wrap tools, so a script's nested `read`/`write`/`bash`
 * calls go through those wrappers (Hearth's approvals) like any other call.
 */
export const hearthCodemodeExtensions = (
  options: HearthCodemodeOptions = {}
): { extensions: Extension[]; close: () => void } => {
  const env = options.env ?? process.env;
  if (!codemodeEnabled(env)) {
    return { extensions: [Scratchpad], close: () => undefined };
  }
  const sandbox = new CodemodeSandbox({});
  const extensions: Extension[] = [
    createCodemodeExtension({
      sandbox,
      ...(options.namespaces === undefined ? {} : { namespaces: options.namespaces }),
      models: true,
    }),
    createToolSearchExtension(),
    Scratchpad,
  ];
  return { extensions, close: () => void sandbox.close().catch(() => undefined) };
};

export { CODEMODE_TOOL_NAME };
