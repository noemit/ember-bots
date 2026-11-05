/**
 * A tiny stdio MCP server for tests: `initialize`, `tools/list` (one `echo` tool), `tools/call`.
 * Newline-delimited JSON-RPC, like the real transport.
 */
const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const handle = (line: string): void => {
  let message: { id?: number; method?: string; params?: { arguments?: { text?: string } } };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "faux", version: "1.0.0" },
      },
    });
  } else if (message.method === "notifications/initialized") {
    // no reply
  } else if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo the given text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    });
  } else if (message.method === "tools/call") {
    const text = message.params?.arguments?.text ?? "";
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `echo: ${text}` }] } });
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
