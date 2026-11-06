import {
  defineExtension,
  wrapTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { leftoverReportPath, removeFileBestEffort } from "./processes";
import { leftoverRecorderSuffix } from "./shell";
import {
  CommandWatch,
  leftoverNote,
  listNonLinuxProcesses,
  scanLeftovers,
  type LeftProcess,
  type ProcessRow,
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
  const list = options.list ?? listNonLinuxProcesses;
  return {
    ...tool,
    execute: async (args, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
      const conversationId = Number(api.conversationId);
      if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return tool.execute(args, api, context);
      const current = (): LeftProcess[] => scan({ fresh: true }).byConversation.get(conversationId) ?? [];
      // On Linux an orphan is recognised from the tree, so "before" is the whole diff baseline. Where
      // the platform needs the ledger, only this command's own recordings count as new.
      const before = new Set(platform === "linux" ? current().map((entry) => entry.pid) : []);
      // Wherever the environment is unreadable, the *shell* is asked to record what it started, and
      // the report is read once the command is over. See `CommandWatch` for why polling this cannot
      // work: a command that finishes in milliseconds has no window in which a poll could run.
      // Both sides have to name the same file, and they are built from different things: the shell
      // gets its environment from the execution env, while this code runs in Hearth's own process.
      // So the path is *derived* here from values both have — the host's home (which the extension
      // resolves) and the conversation — rather than read back from an environment this file cannot
      // see. Passing it through `context` is not an option: the tool API carries no per-call env.
      const reportPath = options.home ? leftoverReportPath(options.home, conversationId) : undefined;
      const watch =
        platform === "linux" || !reportPath
          ? undefined
          : new CommandWatch({ conversationId, list, reportPath });
      const finish = watch?.start();
      // Where the shell must report for itself, the recorder is appended to the command it runs —
      // inside the same `bash -c`, so `$!` and `jobs -p` are the jobs that command actually started.
      // Appended rather than prepended so the exit status and the output stay the command's own:
      // the suffix ends in `true` and never touches `$?`.
      const original = (args ?? {}) as Record<string, unknown>;
      const wrapped =
        watch && typeof original.command === "string"
          ? `${original.command}\n${leftoverRecorderSuffix()}`
          : null;
      let result: ToolExecutionResult;
      try {
        result = await tool.execute(
          wrapped === null ? args : ({ ...original, command: wrapped } as typeof args),
          api,
          context
        );
      } finally {
        finish?.();
        // The report is this command's only; leaving it behind would accumulate one file per command.
        if (reportPath) removeFileBestEffort(reportPath);
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
