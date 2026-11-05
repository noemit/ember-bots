import { defineExtension, hook, GenerationTask } from "@earendil-works/pi-durable";

/**
 * Surface provider failures in the host log. A failed generation settles the submission as
 * `unanswered` with a reason, and nothing is appended to the transcript — so from the UI it
 * looks like the agent simply never replied. This hook logs the terminal provider message
 * (provider, model, stop reason, error) whenever a turn ends badly.
 */
export const Diagnostics = defineExtension({
  name: "diagnostics",
  hooks: [
    hook(GenerationTask, {
      afterResponse: (message) => {
        if (message.stopReason === "stop" || message.stopReason === "toolUse") return;
        const summary = {
          provider: message.provider,
          model: message.model,
          stopReason: message.stopReason,
          ...(message.errorMessage ? { error: message.errorMessage.slice(0, 500) } : {}),
        };
        console.error(`[hearth] generation ${message.stopReason}: ${JSON.stringify(summary)}`);
      },
    }),
  ],
});
