/**
 * Keyword-triggered context: a small rules document ("when the message mentions X, inject Y")
 * and the submit-time injection that makes it real.
 *
 * Injection writes a `hearth.context` entry ahead of the input: a `write` submission the model
 * sees in its context but the transcript skips (same mechanism as Ember's reply-context). The
 * entry carries the text twice, deliberately — `data` for the transcript, provenance and this
 * module's own reads, and `model` for the request. **Only `model` reaches the model**: pi-durable
 * derives the next request from `entry.model` (`harness/context.js`), so an entry with `data`
 * alone is invisible to it and the rule is cosmetic. Rules live in a session-scoped document, so
 * they survive restarts and apply on every device that shares the storage. Matching is a
 * case-insensitive substring test over the message text.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { defineDoc, type ConversationId, type EntryDraft, type Harness } from "@earendil-works/pi-durable";

export type ContextRule = {
  id: string;
  /** Case-insensitive substrings; any match injects `text` for that turn. */
  keywords: string[];
  text: string;
  enabled: boolean;
  createdAt: number;
};

export type ContextRulesState = { rules: ContextRule[]; sequence: number };

/** Keyword rules; a session-scoped singleton (global to this storage). */
export const ContextRulesDoc = defineDoc<ContextRulesState>({
  kind: "hearth.context-rules",
  version: 1,
  scope: "session",
  initial: () => ({ rules: [], sequence: 0 }),
  checkpointWhen: () => true,
});

export const listContextRules = async (
  harness: Harness,
  context: Context = BACKGROUND_CONTEXT
): Promise<ContextRulesState> => (await harness.snapshot(ContextRulesDoc, context)) ?? { rules: [], sequence: 0 };

/** Rules whose keywords appear in `content`, case-insensitively. */
export const matchingRules = (rules: readonly ContextRule[], content: string): ContextRule[] => {
  const haystack = content.toLowerCase();
  return rules.filter(
    (rule) => rule.enabled && rule.keywords.some((keyword) => keyword && haystack.includes(keyword.toLowerCase()))
  );
};

export type ContextRuleInput = { keywords: string[]; text: string; enabled: boolean };

const cleanKeywords = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim().slice(0, 80))
        .slice(0, 50)
    : [];

export const parseContextRuleInput = (body: Record<string, unknown>): ContextRuleInput | null => {
  const keywords = cleanKeywords(body.keywords);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (keywords.length === 0 || !text) return null;
  return { keywords, text: text.slice(0, 20_000), enabled: body.enabled !== false };
};

export const parseContextRulePatch = (body: Record<string, unknown>): Partial<ContextRuleInput> => {
  const patch: Partial<ContextRuleInput> = {};
  const keywords = cleanKeywords(body.keywords);
  if (keywords.length > 0) patch.keywords = keywords;
  if (typeof body.text === "string" && body.text.trim()) patch.text = body.text.trim().slice(0, 20_000);
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  return patch;
};

export const createContextRule = async (
  harness: Harness,
  input: ContextRuleInput,
  context: Context = BACKGROUND_CONTEXT
): Promise<ContextRule> => {
  let created: ContextRule | undefined;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ContextRulesDoc);
    doc.sequence += 1;
    created = { id: `rule_${doc.sequence}`, createdAt: Date.now(), ...input };
    doc.rules.push(created);
  }, context);
  return created as ContextRule;
};

export const updateContextRule = async (
  harness: Harness,
  id: string,
  patch: Partial<ContextRuleInput>,
  context: Context = BACKGROUND_CONTEXT
): Promise<ContextRule | undefined> => {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ContextRulesDoc);
    const rule = doc.rules.find((entry) => entry.id === id);
    if (rule) Object.assign(rule, patch);
  }, context);
  return (await listContextRules(harness, context)).rules.find((entry) => entry.id === id);
};

export const deleteContextRule = async (
  harness: Harness,
  id: string,
  context: Context = BACKGROUND_CONTEXT
): Promise<boolean> => {
  let removed = false;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ContextRulesDoc);
    const next = doc.rules.filter((entry) => entry.id !== id);
    removed = next.length !== doc.rules.length;
    doc.rules = next;
  }, context);
  return removed;
};

/**
 * Frame injected text so the model reads it as material, not as something a person said. A bare
 * rule body sitting in a user turn reads as an instruction from the human, which is exactly what
 * a keyword rule is not.
 */
export const CONTEXT_PREAMBLE = "Context injected by Hearth, not a user message:";

/**
 * One context entry: `kind` and `data` for the transcript (Ember skips the kind; `data` keeps the
 * rule's raw text and id for provenance), `model` for the request.
 *
 * The message is `role: "user"`, not `"system"`, and that is not a stylistic choice. pi-ai calls
 * `collapseSystemMessages` for every model without `compat.supportsMidConvoSystemMessages` (false
 * by default), and collapsing keeps only the *newest* system message — a mid-transcript system
 * note would replace the whole system prompt, tools and all. A user-role text message needs no
 * compat flag, survives `deriveContext` and `orderToolResults` untouched, and converts on every
 * provider.
 */
export const contextEntry = (rule: ContextRule, now = Date.now()): EntryDraft => ({
  kind: "hearth.context",
  data: { ruleId: rule.id, text: rule.text },
  model: [{ role: "user", content: [{ type: "text", text: `${CONTEXT_PREAMBLE} ${rule.text}` }], timestamp: now }],
});

/**
 * The `model` messages a write entry may carry, or `undefined` for none.
 *
 * A write entry reaches the model through `model` alone — pi-durable derives the next request from
 * it, so a `data`-only entry is transcript decoration. Callers that mean the model to read
 * something (reply context, a queued message's instructions, Ember's side) therefore have to send
 * it here. Only user-role text is accepted: a client may hand the model something to read, never an
 * assistant turn or a tool result it did not produce.
 */
export const parseEntryModel = (value: unknown): Message[] | undefined | "invalid" => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return "invalid";
  const messages: Message[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return "invalid";
    const message = candidate as { role?: unknown; content?: unknown; timestamp?: unknown };
    if (message.role !== "user") return "invalid";
    const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    const content: Array<{ type: "text"; text: string }> = [];
    for (const part of parts) {
      const text = (part as { type?: unknown; text?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined;
      if (typeof text !== "string" || text.length === 0 || text.length > 40_000) return "invalid";
      content.push({ type: "text", text });
    }
    if (content.length === 0) return "invalid";
    const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
    messages.push({ role: "user", content, timestamp });
  }
  return messages;
};

/** True when `value` is a valid user-role text `entry.model` array. */
export const isEntryModel = (value: unknown): value is Message[] => {
  const parsed = parseEntryModel(value);
  return parsed !== undefined && parsed !== "invalid";
};

/**
 * Write the matching rules' text as `hearth.context` entries ahead of the input. Returns the ids
 * that fired. Called from the submit route for `type: "input"` submissions.
 */
export const injectContextForInput = async (
  harness: Harness,
  conversationId: ConversationId,
  content: string,
  context: Context = BACKGROUND_CONTEXT
): Promise<string[]> => {
  const state = await listContextRules(harness, context);
  const matches = matchingRules(state.rules, content);
  if (matches.length === 0) return [];
  const conversation = await harness.conversation(conversationId, context);
  if (!conversation) return [];
  for (const rule of matches) {
    await conversation.submit({ type: "write", entry: contextEntry(rule) }, context);
  }
  return matches.map((rule) => rule.id);
};
