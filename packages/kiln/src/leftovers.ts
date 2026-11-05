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
  CommandWatch,
  leftoverNote,
  listWindowsProcesses,
  scanLeftovers,
  type LeftProcess,
  type ProcessRow,
  type ProcessScan,
} from "./processes";

export type WatchOptions = {
  /** The host's leftovers; tests inject a fake table. */
  scan?: (options?: { fresh?: boolean }) => ProcessScan;
  /** Test seam for the platform split (Linux reads `/proc`, elsewhere polls a ledger). */
  platform?: NodeJS.Platform;
  /** The Windows process table, for the ledger's liveness checks. */
  list?: () => ProcessRow[];
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
 * `CommandWatch` covers platforms whose process environment is not readable: there the attribution is
 * built while the command runs, so the recording has to stop before the scan.
 */
export const watchBash = (tool: ToolRegistration, options: WatchOptions = {}): ToolRegistration => {
  const scan = options.scan ?? scanLeftovers;
  const platform = options.platform ?? process.platform;
  const list = options.list ?? listWindowsProcesses;
  return {
    ...tool,
    execute: async (args, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
      const conversationId = Number(api.conversationId);
      if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return tool.execute(args, api, context);
      const current = (): LeftProcess[] => scan({ fresh: true }).byConversation.get(conversationId) ?? [];
      // On Linux an orphan is recognised from the tree, so "before" is the whole diff baseline. Where
      // the platform needs the ledger, only this command's own recordings count as new.
      const before = new Set(platform === "linux" ? current().map((entry) => entry.pid) : []);
      const finish = platform === "linux" ? undefined : new CommandWatch({ conversationId, list }).start();
      let result: ToolExecutionResult;
      try {
        result = await tool.execute(args, api, context);
      } finally {
        finish?.();
      }
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
  wraps: [wrapTool(createBashTool(), (tool: ToolRegistration) => watchBash(tool))],
});
