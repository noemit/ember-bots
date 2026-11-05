/**
 * Minimal MCP (Model Context Protocol) client + Hearth extension — the Phase-3 spike.
 *
 * Hearth spawns each configured MCP server over stdio, initializes it, lists its tools, and
 * registers each as a Hearth tool. Because TypeBox schemas *are* JSON Schema, an MCP tool's
 * `inputSchema` passes through as the tool's parameters with no conversion; pi-ai validates the
 * model's arguments against it exactly as it does for the built-in tools.
 *
 * Configured in `$HEARTH_HOME/mcp.json` (Claude-style). Add `"tool": "<name>"` to collapse a
 * server's tools into one action-dispatch tool (Playwright's 25 → `browser`), optionally with
 * `"exclude": [...]` and an explicit `"actionPrefix"`:
 *   { "mcpServers": { "playwright": { "tool": "browser", "command": "npx",
 *     "args": ["@playwright/mcp@latest", "--user-data-dir", "/workspace/.playwright-profile"] } } }
 *
 * Two `pi-durable` 1.4.0 details shape the tools this builds:
 * - A result carries `output` (what the model reads), not the old `content`.
 * - `callers: ["model", "tools"]` makes the tools callable from a `codemode` script as
 *   `tools.<name>(args)`, not only by the model.
 *
 * `replay` follows what the tool does to the world. Reading a server's `annotations.readOnlyHint`
 * (or a config's `readOnly` / `readOnlyTools`) marks a tool `replay: "safe"`: a durable tool task
 * that a restart interrupted reruns it, which is fine for a pure read and wrong for a click. A
 * collapsed tool is safe only when every action behind it is.
 */
import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { lit, obj, oneOf, opt, str, type Schema } from "@earendil-works/pi-schema";
import { base64LengthLimit } from "./images";
import { withAbortRace } from "./interrupt";
import { MAX_IMAGE_BYTES, detectImageMimeType } from "./view";

const DATA_URL_PREFIX = /^data:[^;,]*;base64,/i;

const PROTOCOL_VERSION = "2024-11-05";
// Generous: a browser MCP server's first call launches Chromium (cold start can take a while).
const REQUEST_TIMEOUT_MS = 120_000;
const INIT_TIMEOUT_MS = 30_000;

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Collapse this server's tools into a single action-dispatch tool with this name (e.g.
   * `"browser"`), instead of one Hearth tool per MCP tool. The action set is the server's tool
   * names with `actionPrefix` stripped; `run_code_unsafe`-style tools are included unless listed
   * in `exclude`.
   */
  tool?: string;
  /** Action names to omit from a collapsed tool (matched against the stripped action or the raw tool name). */
  exclude?: string[];
  /** Prefix stripped from MCP tool names to form actions. Default: the longest common `_`-delimited prefix. */
  actionPrefix?: string;
  /**
   * Every tool of this server only reads: mark them `replay: "safe"`, so a tool task a restart
   * interrupted runs again instead of being abandoned. Use it for a server that predates
   * `annotations.readOnlyHint`.
   */
  readOnly?: boolean;
  /** Individual tool names that only read (the same effect for a server that mixes both). */
  readOnlyTools?: string[];
};
export type McpConfig = { mcpServers: Record<string, McpServerConfig> };

/** What actually loaded, for logging and for the system prompt (so an agent can't guess). */
export type McpSummary = {
  configPath: string;
  servers: Array<{
    name: string;
    /** Tools exposed to conversations (1 when collapsed). */
    toolCount: number;
    command: string;
    /** The collapsed tool's name, when the server is presented as one action-dispatch tool. */
    tool?: string;
    /** The number of actions behind a collapsed tool. */
    actions?: number;
  }>;
};

/**
 * The `codemode` namespaces for the loaded servers: one per server whose tools are registered
 * individually (`<server>__<tool>`), so a script sees `tools.github_search(...)` grouped under
 * `github` and the `codemode` section prints them together. A collapsed server has one tool with
 * its own name and no prefix to group by, so it gets none.
 */
export const mcpNamespaces = (summary: McpSummary): CodemodeNamespace[] =>
  summary.servers
    .filter((server) => server.tool === undefined && server.toolCount > 0)
    .map((server) => ({
      name: server.name,
      prefix: `${server.name}_`,
      description: `MCP server ${server.name}`,
    }));

/** A prompt section stating the real MCP provenance, so the model doesn't invent it. */
export const mcpSection = (summary: McpSummary) =>
  section(
    "mcp_servers",
    () => {
      if (summary.servers.length === 0) return undefined;
      const lines = summary.servers.map((server) =>
        server.tool
          ? `- ${server.tool}: ${server.actions ?? 0} action(s) via \`${server.command}\``
          : `- ${server.name}: ${server.toolCount} tool(s) via \`${server.command}\``
      );
      return `MCP servers loaded from ${summary.configPath || "mcp.json"}:\n${lines.join("\n")}`;
    },
    { tag: false }
  );

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One stdio MCP server: newline-delimited JSON-RPC over the child's stdin/stdout. */
class McpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private closed = false;

  constructor(command: string, args: string[], env: Record<string, string> | undefined) {
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(env ?? {}) },
      // Its own process group, so `close()` can end the whole chain. An MCP server is usually a
      // launcher (`npx -y @playwright/mcp`) that starts the real server, which starts a browser:
      // signalling only the direct child left `node playwright-mcp` and its Chromium running, on
      // every platform. On Windows there is no group to start; `taskkill /T` walks the tree there.
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error("[hearth] mcp stderr:", text.slice(0, 400));
    });
    this.proc.on("exit", (code) => this.failAll(new Error(`mcp server exited (${code ?? "signal"})`)));
    this.proc.on("error", (error) => this.failAll(error));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onMessage(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onMessage(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // not a JSON-RPC line (some servers log to stdout)
    }
    if (typeof message.id !== "number") return; // notification
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message ?? "mcp error"));
    else entry.resolve(message.result);
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private send(message: JsonRpcMessage): void {
    if (this.closed) throw new Error("mcp server is closed");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(): Promise<void> {
    await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "hearth", version: "0.1.0" } },
      INIT_TIMEOUT_MS
    );
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolInfo[] };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content?: unknown[]; isError?: boolean }> {
    return (await this.request("tools/call", { name, arguments: args })) as { content?: unknown[]; isError?: boolean };
  }

  close(): void {
    this.failAll(new Error("mcp client closed"));
    const pid = this.proc.pid;
    if (pid === undefined) return;
    try {
      if (process.platform === "win32") {
        // `proc.kill()` ends the launcher and orphans everything it started.
        spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], {
          stdio: "ignore",
          windowsHide: true,
        }).on("error", () => undefined);
      } else {
        // The group the server was started in (negative pid): the launcher, the server, its browser.
        process.kill(-pid, "SIGTERM");
        // A browser may ignore SIGTERM; end it rather than leaving it to accumulate across restarts.
        const escalate = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // already gone
          }
        }, 1_500);
        escalate.unref?.();
      }
    } catch {
      // already gone
    }
  }
}

/** Read `$HEARTH_HOME/mcp.json`; a missing or malformed file yields no servers. */
export const readMcpConfig = (path: string): McpConfig => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as McpConfig;
    return parsed && typeof parsed === "object" && parsed.mcpServers ? parsed : { mcpServers: {} };
  } catch {
    return { mcpServers: {} };
  }
};

/** One `tools/list` entry. */
export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** MCP tool annotations (`readOnlyHint`, `destructiveHint`, …); servers may omit them. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [key: string]: unknown };
};

/**
 * Whether an MCP tool only reads, and so may be `replay: "safe"`: the config says so for the whole
 * server (`readOnly`) or for this name (`readOnlyTools`), or the server's own
 * `annotations.readOnlyHint` is `true`. A missing or non-boolean hint is not a promise of safety.
 */
export const isReadOnlyMcpTool = (settings: McpServerConfig, tool: McpToolInfo): boolean => {
  if (settings.readOnly === true) return true;
  if (settings.readOnlyTools?.includes(tool.name) === true) return true;
  return tool.annotations?.readOnlyHint === true;
};

/**
 * Map an MCP `tools/call` result's content to Hearth tool-result content. Text passes through;
 * an image part (base64 `data` + `mimeType`, e.g. a Playwright screenshot) is forwarded as an
 * `ImageContent` block — pi-ai sends it to image-capable models, so screenshots are seen, not
 * stringified. Anything else is JSON text.
 */
export const mcpContentToHearth = (content: unknown): (TextContent | ImageContent)[] => {
  if (!Array.isArray(content)) return [];
  const out: (TextContent | ImageContent)[] = [];
  const maxMb = MAX_IMAGE_BYTES / 1024 / 1024;
  for (const part of content) {
    if (!part || typeof part !== "object") {
      out.push({ type: "text", text: String(part) });
      continue;
    }
    const record = part as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      out.push({ type: "text", text: record.text });
    } else if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
      const data = record.data.replace(DATA_URL_PREFIX, "").trim();
      if (!data) {
        out.push({ type: "text", text: "(empty MCP image omitted)" });
        continue;
      }
      if (data.length > base64LengthLimit(MAX_IMAGE_BYTES)) {
        out.push({ type: "text", text: `(MCP image omitted: exceeds ${maxMb}MB limit)` });
        continue;
      }
      const bytes = Buffer.from(data, "base64");
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        out.push({ type: "text", text: `(MCP image omitted: ${Math.round(bytes.byteLength / 1024 / 1024)}MB exceeds ${maxMb}MB limit)` });
        continue;
      }
      const sniffedMime = detectImageMimeType(bytes);
      out.push({ type: "image", data, mimeType: sniffedMime ?? record.mimeType });
    } else {
      out.push({ type: "text", text: JSON.stringify(part) });
    }
  }
  return out;
};

/** The longest common prefix of `names` that ends at an `_` boundary (empty when there is none). */
export const commonActionPrefix = (names: readonly string[]): string => {
  if (names.length === 0) return "";
  let prefix = names[0];
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  const cut = prefix.lastIndexOf("_");
  return cut >= 0 ? prefix.slice(0, cut + 1) : "";
};

/** The action name for a tool: its name with `prefix` stripped (the name itself when it does not carry it). */
export const actionNameOf = (toolName: string, prefix: string): string =>
  prefix && toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;

const firstLine = (text: string | undefined): string => (text ?? "").split("\n")[0]?.trim() ?? "";

/** A short, one-line label for a running browser action (URL, target, text, index, …). */
const actionLabel = (args: Record<string, unknown>): string => {
  for (const key of ["url", "text", "target", "key", "filename", "index"]) {
    const value = args[key];
    if (typeof value === "string" && value) return ` ${value.slice(0, 80)}`;
    if (typeof value === "number") return ` ${value}`;
  }
  return "";
};

/**
 * Collapse a server's tools into one action-dispatch tool: `action` selects the underlying MCP
 * tool and the remaining inputs are forwarded. Extra inputs may be passed alongside `action` or
 * nested under `parameters` (models do both).
 */
const buildCollapsedTool = (
  exposedName: string,
  listed: McpToolInfo[],
  client: McpClient,
  settings: McpServerConfig
): { tool: ToolRegistration; actionCount: number } => {
  const prefix = settings.actionPrefix ?? commonActionPrefix(listed.map((tool) => tool.name));
  const excluded = new Set(settings.exclude ?? []);
  const entries: Array<{ action: string; tool: string; description?: string; readOnly: boolean }> = [];
  const seen = new Set<string>();
  for (const tool of listed) {
    const action = actionNameOf(tool.name, prefix);
    if (!action || excluded.has(action) || excluded.has(tool.name) || seen.has(action)) continue;
    seen.add(action);
    entries.push({ action, tool: tool.name, description: tool.description, readOnly: isReadOnlyMcpTool(settings, tool) });
  }
  const byAction = new Map(entries.map((entry) => [entry.action, entry.tool]));
  const parameters = obj(
    {
      action:
        entries.length > 0
          ? oneOf(
              entries.map((entry) => entry.action),
              { description: "The action to perform." }
            )
          : str({ description: "The action to perform." }),
      parameters: opt(
        obj(
          {},
          { open: true, description: "Inputs for the chosen action; may also be passed alongside `action`." }
        )
      ),
    },
    // An MCP server's own inputs travel in `parameters` (or alongside `action`), so the object must
    // accept more than the two names Hearth knows.
    { open: true }
  );
  const description = [
    `Drive the ${exposedName} via its MCP server. Pick one action per call and pass that action's inputs (top-level or under \`parameters\`). Actions:`,
    ...entries.map((entry) => `- ${entry.action}: ${firstLine(entry.description)}`),
  ].join("\n");
  const tool = defineTool({
    name: exposedName,
    description,
    parameters,
    // Safe only when every action behind it is: a rerun must not click twice.
    replay: entries.length > 0 && entries.every((entry) => entry.readOnly) ? "safe" : "unsafe",
    // A script can drive it too: `tools.<exposedName>({ action, ...inputs })`.
    callers: ["model", "tools"],
    execute: async (input, api) => {
      const { action, parameters: nested, ...flat } = (input ?? {}) as Record<string, unknown>;
      const toolName = byAction.get(String(action));
      if (!toolName) {
        return {
          output: [{ type: "text" as const, text: `Unknown ${exposedName} action '${String(action)}'.` }],
          isError: true,
        };
      }
      const args = { ...flat, ...((nested as Record<string, unknown> | undefined) ?? {}) };
      api.output(`${String(action)}${actionLabel(args)}\n`);
      const result = await client.callTool(toolName, args);
      const output = mcpContentToHearth(result.content);
      return {
        output: output.length > 0 ? output : [{ type: "text" as const, text: "(no output)" }],
        ...(result.isError ? { isError: true } : {}),
      };
    },
  });
  return { tool, actionCount: entries.length };
};

/**
 * Spawn every configured server and build one Hearth tool per MCP tool, namespaced
 * `<server>__<tool>`. Servers that fail to start are logged and skipped. `close()` kills them.
 */
export const buildMcpTools = async (
  config: McpConfig,
  configPath = ""
): Promise<{ tools: ToolRegistration[]; close: () => void; summary: McpSummary }> => {
  const clients: McpClient[] = [];
  const tools: ToolRegistration[] = [];
  const servers: McpSummary["servers"] = [];
  for (const [server, settings] of Object.entries(config.mcpServers)) {
    if (!settings?.command) continue;
    try {
      const client = new McpClient(settings.command, settings.args ?? [], settings.env);
      clients.push(client);
      await client.initialize();
      const listed = (await client.listTools()) as McpToolInfo[];
      const command = [settings.command, ...(settings.args ?? [])].join(" ");
      if (settings.tool) {
        // One action-dispatch tool instead of one tool per MCP tool (e.g. Playwright's 25 → `browser`).
        const collapsed = buildCollapsedTool(settings.tool, listed, client, settings);
        tools.push(withAbortRace(collapsed.tool));
        servers.push({ name: server, toolCount: 1, command, tool: settings.tool, actions: collapsed.actionCount });
        console.log(
          `[hearth] mcp server ${server}: ${collapsed.actionCount} action(s) exposed as \`${settings.tool}\` (from ${configPath || "mcp.json"})`
        );
      } else {
        let count = 0;
        for (const tool of listed) {
          tools.push(
            withAbortRace(
              defineTool({
                name: `${server}__${tool.name}`,
                description: tool.description ?? `${server} MCP tool: ${tool.name}`,
                // An MCP server ships its own JSON Schema; pi-schema's `Schema` is exactly that shape.
                parameters: (tool.inputSchema ?? obj({}, { open: true })) as Schema,
                replay: isReadOnlyMcpTool(settings, tool) ? "safe" : "unsafe",
                // Callable from a `codemode` script: `tools.<server>__<tool>(args)`.
                callers: ["model", "tools"],
                execute: async (args: Record<string, unknown>) => {
                  const result = await client.callTool(tool.name, args ?? {});
                  const output = mcpContentToHearth(result.content);
                  return {
                    output: output.length > 0 ? output : [{ type: "text" as const, text: "(no output)" }],
                    ...(result.isError ? { isError: true } : {}),
                  };
                },
              })
            )
          );
          count += 1;
        }
        servers.push({ name: server, toolCount: count, command });
        console.log(`[hearth] mcp server ${server}: ${count} tool(s) registered (from ${configPath || "mcp.json"})`);
      }
    } catch (error) {
      console.error(`[hearth] mcp server ${server} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return { tools, close: () => clients.forEach((client) => client.close()), summary: { configPath, servers } };
};
