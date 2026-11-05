import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Making a step interruptible.
 *
 * pi-durable ends a run between task phases, so a tool's `execute()` must return before an
 * abort can take effect. A tool that ignores its cancellation context (a wedged `bash`
 * child, an MCP server that never answers) therefore pins the run: `POST /abort` blocks on
 * `Conversation.abort()` until the step finishes, and Ember's stop appears to hang.
 *
 * `withAbortRace` races the tool's own `execute()` against its abort signal. When the run is
 * stopped, the wrapper rejects at once, the tool task settles `aborted`, and the run ends —
 * without waiting for the wedged step. The step itself may keep running in the background;
 * we fire a best-effort `onAbort` so a process it owns (e.g. an MCP child call) can be
 * cleaned up, and we swallow the late rejection so it can never become an unhandled one.
 */

/** A rejection carrying the caller's abort reason, recognisable without matching a message. */
class AbortSignalError extends Error {
  constructor() {
    super("The step was interrupted");
    this.name = "AbortSignalError";
  }
}

export const isAbortSignalError = (error: unknown): boolean => error instanceof AbortSignalError;

/**
 * Reject as soon as `context.abortSignal` aborts, whatever `task` is doing. `onAbort` runs
 * once on abort for best-effort cleanup; its own failure is reported, never thrown.
 */
export const raceAbort = async <T,>(
  task: Promise<T>,
  context: Context | undefined,
  onAbort?: () => void
): Promise<T> => {
  const signal = context?.abortSignal;
  if (!signal) return task;
  if (signal.aborted) {
    void task.catch(() => {});
    onAbort?.();
    throw new AbortSignalError();
  }
  return await new Promise<T>((resolve, reject) => {
    const onSignal = (): void => {
      signal.removeEventListener("abort", onSignal);
      // Let the in-flight step finish on its own; never let its rejection escape.
      void task.catch(() => {});
      try {
        onAbort?.();
      } catch {
        // cleanup is best effort
      }
      reject(new AbortSignalError());
    };
    signal.addEventListener("abort", onSignal, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", onSignal);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onSignal);
        reject(error);
      }
    );
  });
};

/**
 * Wrap a tool so its `execute()` observes the run's abort signal. Any `execute` that checks
 * the signal itself is unaffected; one that does not is cut loose when the run is stopped.
 */
export const withAbortRace = (tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  execute: (args: unknown, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> =>
    raceAbort(Promise.resolve(tool.execute(args, api, context)), context),
});
