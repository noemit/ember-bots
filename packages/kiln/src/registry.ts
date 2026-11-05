import { createRegistry, type Registry } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Approvals } from "./approvals";
import { Leftovers } from "./leftovers";
import { AskTool } from "./ask";
import { Sessions } from "./sessions";
import { agentsExtension, createAgentsMdSection } from "./agents";
import { hearthCodemodeExtensions } from "./codemode";
import { spawnGuard } from "./crew";
import { hearthConfig } from "./config";
import { Diagnostics } from "./diagnostics";
import { View } from "./view";

/** The ask tool bundled as its own extension so conversations can deselect it. */
const Ask = {
  name: "ask",
  tools: [AskTool],
} as const;

export type HearthRegistryOptions = {
  /** MCP server namespaces, so the `codemode` section groups their tools by server. */
  namespaces?: readonly CodemodeNamespace[];
};

/**
 * Hearth's registry: code mode (`codemode`, `tool_search`, `scratchpad`), the built-in coding
 * tools (gated by approvals behind the wraps), the `view` tool, the ask tool, the AGENTS.md
 * section for the conversation's cwd, the agent directory/messaging tools, and provider-failure
 * diagnostics. Extensions resolve by name, so a stored selection survives restarts and code
 * changes.
 *
 * Code mode goes in first: a `codemode` script calls its nested tools as `tools.read(...)` and
 * the rest, and those calls must go through `Approvals` exactly like a model's call would —
 * installing the wrappers after the code mode tools keeps them in the composed tool set a nested
 * call resolves against. Nothing else is needed to make the built-ins callable from a script:
 * pi-durable 1.4.0 treats a tool without `callers` as callable by both the model and other tools,
 * which is what `CodingTools` and `view` are. Tools that must stay model-only (or script-only)
 * say so themselves.
 *
 * The code mode sandbox holds no worker between runs (each script gets its own), so its `close()`
 * is not needed here: nothing outlives a script except in-flight executions, which end with the
 * process.
 *
 * `home` is where the passive `known_agents` mirror (`agents.json`) lives; tests pass a temp
 * home so the section can be exercised without touching the real one.
 */
export const hearthRegistry = (
  home: string = hearthConfig().home,
  options: HearthRegistryOptions = {}
): Registry => {
  const registry = createRegistry();
  // Before `Sessions`, so a refused spawn is blocked before the tool runs. The `session` tool checks
  // the same rules itself; this is the copy the model cannot talk its way past.
  registry.install(spawnGuard);
  const codemode = hearthCodemodeExtensions({
    ...(options.namespaces === undefined ? {} : { namespaces: options.namespaces }),
  });
  for (const extension of codemode.extensions) registry.install(extension);
  registry.install(CodingTools);
  // `view`: show an image file to a vision-capable model (pi-durable's `read` refuses images).
  registry.install(View);
  registry.install(Approvals);
  // After `Approvals`: reports what a shell command left running, outside the gate.
  registry.install(Leftovers);
  registry.install(Ask);
  // The `session` tool: start and manage sibling sessions a human can see in Ember.
  registry.install(Sessions);
  registry.install({
    name: "agents-md",
    sections: [createAgentsMdSection(home)],
  });
  // `agents`: the local name directory, direct sends, and pin/unpin (no register — humans promote).
  registry.install(agentsExtension(home));
  registry.install(Diagnostics);
  // The reasoning level a turn ran at is recorded by pi-durable itself since 1.5.0 (it sets
  // `thinkingLevel` on the stored assistant message from the request it made), so Hearth's own
  // `levelStamp` hook — and the gap it existed to fill — is gone.
  return registry;
};
