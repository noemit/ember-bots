/**
 * A tiny stdio MCP server standing in for Playwright: several `browser_*` tools (so the common
 * prefix is `browser_`) plus one that returns an image part. Used to test the collapsed-tool
 * path in `src/mcp.ts`.
 */
export {};
const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const tools = [
  {
    name: "browser_navigate",
    description: "Navigate to a URL",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "browser_click",
    description: "Click an element",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
  },
  {
    name: "browser_drop",
    description: "Drop files onto an element",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
  },
  {
    name: "browser_take_screenshot",
    description: "Take a screenshot of the page",
    inputSchema: { type: "object", properties: {} },
  },
];

const handle = (line: string): void => {
  let message: { id?: number; method?: string; params?: { name?: string; arguments?: { url?: string; target?: string } } };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "playwright", version: "1.0.0" } },
    });
  } else if (message.method === "notifications/initialized") {
    // no reply
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  } else if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name === "browser_navigate") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `navigated to ${args.url ?? ""}` }] } });
    } else if (name === "browser_click") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `clicked ${args.target ?? ""}` }] } });
    } else if (name === "browser_drop") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `dropped on ${args.target ?? ""}` }] } });
    } else if (name === "browser_take_screenshot") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            { type: "text", text: "screenshot" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
        },
      });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `unknown ${name ?? ""}` }] } });
    }
  } else if (typeof message.id === "number") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(line);
    newline = buffer.indexOf("\n");
  }
});
