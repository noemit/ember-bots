import {
  defineExtension,
  wrapTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import {
  leftoverNote,
  scanLeftovers,
  type LeftProcess,
  type ProcessScan,
} from "./processes";

export type WatchOptions = {
  /** The host's leftovers; tests inject a fake table. */
  scan?: (options?: { fresh?: boolean }) => ProcessScan;
  /**
   * The host's data home, where a command's report file is written.
   *
   * Required for the non-Linux path: without it there is nowhere to report to, and the note would
   * silently stop working rather than say so.
   */
  home?: string;
  /** Test seam for the platform split (Linux reads `/proc`, elsewhere polls a ledger). */
  platform?: NodeJS.Platform;
};

/**
 * Tell a session what its own command left running.
 *
 * Written into the tool **result**, not into the prompt: an agent acts on what a command told it,
 * and a rule in the system prompt about cleaning up is the kind of instruction that gets skimmed.
 * The note names the processes, their cost and the exact `kill`, so the next step is a command the
 * model can copy rather than an obligation it has to remember.
 *
 * The scan is a diff around the one command — processes already running before it are not mentioned
 * again on every later call, which would train the model to ignore the line.
 *
 * **Linux only** (see `src/processes.ts`): the attribution needs `/proc`, and on a platform without
 * it the wrapper passes the command straight through, so the agent is told nothing rather than told
 * something unreliable.
 */
export const watchBash = (tool: ToolRegistration, options: WatchOptions = {}): ToolRegistration => {
  const scan = options.scan ?? scanLeftovers;
  const platform = options.platform ?? process.platform;
  return {
    ...tool,
    execute: async (args, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
      const conversationId = Number(api.conversationId);
      if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return tool.execute(args, api, context);
      // Linux only, deliberately.
      //
      // Attribution here reads `/proc/<pid>/environ` for the tag every command inherits, which is
      // exact and costs nothing. Everywhere else that is unreadable, and three attempts at working
      // around it all failed for the same reason: a poll cannot observe a command that finishes in
      // milliseconds (the child is reparented before the next look), and asking the shell to report
      // its own jobs still could not distinguish a real leftover from a backgrounded process whose
      // parent had not yet exited. The feature was switched off on those platforms rather than left
      // half-working: a note that appears on some machines and not others teaches people to ignore
      // it. `scanLeftovers` still answers honestly there — it just always has nothing to say.
      if (platform !== "linux") return tool.execute(args, api, context);
      const current = (): LeftProcess[] => scan({ fresh: true }).byConversation.get(conversationId) ?? [];
      const before = new Set(current().map((entry) => entry.pid));
      const result: ToolExecutionResult = await tool.execute(args, api, context);
      const fresh = current().filter((entry) => !before.has(entry.pid));
      if (fresh.length === 0) return result;
      return {
        ...result,
        output: [...(result.output ?? []), { type: "text", text: leftoverNote(fresh) }],
      };
    },
  };
};

/**
 * Installed after `Approvals`, so the note is written *outside* the gate: a command does not hold an
 * approval wait open while Hearth reads the process table, and a rejected command never reaches it.
 */
export const Leftovers = defineExtension({
  name: "leftovers",
  wraps: [
    wrapTool(createBashTool(), (tool: ToolRegistration) =>
      watchBash(tool, {
        // Resolved per command, not at install: a host's home comes from its environment, and the
        // registry is built once for a process that may outlive a test's temporary home.
        home: process.env.HEARTH_HOME ?? process.env.EMBER_HOME,
      })
    ),
  ],
});
