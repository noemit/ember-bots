#!/usr/bin/env bun
/**
 * Manage Hearth's provider credentials (see PROVIDER_MIGRATION.md). Talks to a running Hearth so
 * its in-memory credential store sees the change; falls back to reading the file for `list`.
 *
 *   bun scripts/provider.ts list
 *   bun scripts/provider.ts set <id> <api-key>
 *   bun scripts/provider.ts remove <id>
 *   bun scripts/provider.ts import
 *   bun scripts/provider.ts login <id>
 *
 * `login` drives an OAuth provider's browser sign-in. The flow is a device code — print it, wait
 * for the human to approve, then store the token — so it works over ssh without a local browser.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const home =
  process.env.HEARTH_HOME ?? (process.platform === "linux" ? "/root/.pi" : join(process.env.HOME ?? ".", ".hearth"));
const port = process.env.HEARTH_PORT ?? "3002";
const base = `http://127.0.0.1:${port}`;
let token = "";
try {
  token = readFileSync(join(home, "hearth.token"), "utf8").trim();
} catch {
  // no token yet
}

const call = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  if (!response.ok) throw new Error(`${response.status} ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  return parsed as Record<string, unknown>;
};

const run = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "list": {
      const result = await call("GET", "/providers");
      const providers = (result.providers as Array<{ id: string; name: string; credential: string | null }>) ?? [];
      for (const provider of providers) {
        const mark = provider.credential ? "✓" : "·";
        const detail = provider.credential ? ` (${provider.credential})` : "";
        console.log(`${mark} ${provider.id.padEnd(16)} ${provider.name}${detail}`);
      }
      const fallback = result.default as { provider: string; modelId: string } | undefined;
      if (fallback) console.log(`\ndefault: ${fallback.provider}/${fallback.modelId}`);
      return;
    }
    case "set": {
      const [id, key] = args;
      if (!id || !key) throw new Error("usage: provider set <id> <api-key>");
      await call("POST", `/providers/${encodeURIComponent(id)}`, { type: "api_key", key });
      console.log(`stored api key for ${id}`);
      return;
    }
    case "remove": {
      const [id] = args;
      if (!id) throw new Error("usage: provider remove <id>");
      await call("DELETE", `/providers/${encodeURIComponent(id)}`);
      console.log(`removed credential for ${id}`);
      return;
    }
    case "login": {
      const [id] = args;
      if (!id) throw new Error("usage: provider login <provider-id>");
      // Start the flow; Hearth returns as soon as the provider emits its first event (the code).
      let state = (await call("POST", `/providers/${encodeURIComponent(id)}/login`)) as {
        status: string;
        events?: Array<Record<string, unknown>>;
        error?: string;
      };
      const shown = new Set<string>();
      const print = (events: Array<Record<string, unknown>> | undefined) => {
        for (const event of events ?? []) {
          const key = JSON.stringify(event);
          if (shown.has(key)) continue;
          shown.add(key);
          if (event.type === "device_code") {
            console.log("");
            console.log(`  To sign in, open:  ${String(event.verificationUri)}`);
            console.log(`  and enter the code:  ${String(event.userCode)}`);
            console.log("");
          } else if (event.type === "auth_url") {
            console.log("");
            console.log(`  Open:  ${String(event.url)}`);
            if (event.instructions) console.log(`  ${String(event.instructions)}`);
            console.log("");
          } else if (event.message) {
            console.log(`  ${String(event.message)}`);
          }
        }
      };
      print(state.events);
      if (state.status === "failed") throw new Error(state.error ?? "login failed");
      if (state.status !== "pending") {
        console.log("signed in");
        return;
      }
      process.stdout.write("  Waiting for approval");
      // Poll until the flow settles. The provider's own code expiry bounds this, so a forgotten
      // login ends rather than spinning forever.
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        state = (await call("GET", `/providers/${encodeURIComponent(id)}/login`)) as typeof state;
        print(state.events);
        if (state.status === "pending") {
          process.stdout.write(".");
          continue;
        }
        console.log("");
        if (state.status === "failed") throw new Error(state.error ?? "login failed");
        console.log("signed in");
        return;
      }
    }
    case "import": {
      const result = await call("POST", "/providers/import");
      const imported = (result.imported as string[]) ?? [];
      console.log(imported.length ? `imported: ${imported.join(", ")}` : "nothing to import");
      return;
    }
    default:
      console.error("usage: provider list|set <id> <api-key>|remove <id>|import|login <id>");
      process.exit(2);
  }
};

void run().catch((error: unknown) => {
  console.error(`provider: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
