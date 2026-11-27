import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  InboxDoc,
  type ConversationId,
  type Harness as HarnessType,
  type InboxItem,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { reorderQueuedInputs } from "../src/parking";
import { QueueConfigDoc } from "../src/queueConfig";

const ctx = BACKGROUND_CONTEXT;

describe("D2: atomic queue reorder", () => {
  test("reorders queued inputs and QueueConfigDoc atomically in one commit and survives DB reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-reorder-d2-"));
    const dbPath = join(dir, "hearth.sqlite");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const openHarness = (store: typeof storage) =>
      Harness.open(
        store,
        { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }) },
        ctx
      );

    let storage = await openNodeSqliteStorage(dbPath);
    let harness: HarnessType | undefined;
    try {
      harness = await openHarness(storage);
      const model = faux.getModel();
      const conv = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id } } },
        ctx
      );
      const cid: ConversationId = conv.id;

      // Seed two queued inputs + one write item + per-item queue configs inside a single commit.
      const ids = await conv.commit(async (tx) => {
        const inbox = await tx.doc(InboxDoc, cid);
        const queueConfig = await tx.doc(QueueConfigDoc, cid);
        const s1 = await tx.createSubmission({ conversationId: cid, type: "input", status: "queued" });
        const s2 = await tx.createSubmission({ conversationId: cid, type: "input", status: "queued" });
        const sw = await tx.createSubmission({ conversationId: cid, type: "write", status: "queued" });
        inbox.items.push(
          { id: s1.id, mode: "followUp", content: "first instruction" } as InboxItem,
          { id: sw.id, mode: "write", entry: { kind: "ember.note", data: { text: "keep me" } } } as InboxItem,
          { id: s2.id, mode: "followUp", content: "second instruction" } as InboxItem
        );
        queueConfig.items[String(s1.id)] = { model: { provider: "openai", modelId: "gpt-4.1" }, thinkingLevel: "low" };
        queueConfig.items[String(s2.id)] = { model: { provider: "anthropic", modelId: "claude-opus-4-6" }, thinkingLevel: "high" };
        return { first: s1.id, second: s2.id, write: sw.id };
      }, ctx);

      // Reorder [second, first] atomically.
      const res = await reorderQueuedInputs(
        (change) => conv.commit(change, ctx),
        cid,
        [String(ids.second), String(ids.first)]
      );
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(res.error);

      const newSecondId = res.replacements[String(ids.second)]!;
      const newFirstId = res.replacements[String(ids.first)]!;
      expect(Number(newSecondId)).toBeLessThan(Number(newFirstId));

      // Originals must be settled as unanswered/aborted in the same commit.
      expect((await storage.submission(ids.first, ctx))?.status).toBe("unanswered");
      expect((await storage.submission(ids.second, ctx))?.status).toBe("unanswered");
      expect((await storage.submission(ids.write, ctx))?.status).toBe("queued");

      // Reopen storage + harness from disk and verify exact order, write preservation, and QueueConfigDoc.
      await harness.close(ctx);
      harness = undefined;
      await storage.close(ctx);

      storage = await openNodeSqliteStorage(dbPath);
      harness = await openHarness(storage);
      const reopenedInbox = await harness.snapshot(InboxDoc, cid, ctx);
      const reopenedConfig = await harness.snapshot(QueueConfigDoc, cid, ctx);

      const isInputItem = (
        item: InboxItem
      ): item is Extract<InboxItem, { mode: "followUp" | "steer" }> =>
        item.mode === "followUp" || item.mode === "steer";

      const inputs = (reopenedInbox?.items ?? []).filter(isInputItem);
      expect(inputs.map((item) => item.content)).toEqual(["second instruction", "first instruction"]);
      expect(inputs.map((item) => String(item.id))).toEqual([newSecondId, newFirstId]);
      expect((reopenedInbox?.items ?? []).some((item) => item.mode === "write" && item.id === ids.write)).toBe(true);

      expect(reopenedConfig?.items[newSecondId]).toEqual({
        model: { provider: "anthropic", modelId: "claude-opus-4-6" },
        thinkingLevel: "high",
      });
      expect(reopenedConfig?.items[newFirstId]).toEqual({
        model: { provider: "openai", modelId: "gpt-4.1" },
        thinkingLevel: "low",
      });
      expect(reopenedConfig?.items[String(ids.first)]).toBeUndefined();
      expect(reopenedConfig?.items[String(ids.second)]).toBeUndefined();

      // A stale reorder naming an already-consumed/missing id is rejected atomically without mutating inbox.
      const reopenedConv = (await harness.conversation(cid, ctx))!;
      const stale = await reorderQueuedInputs(
        (change) => reopenedConv.commit(change, ctx),
        cid,
        [String(ids.first), newFirstId]
      );
      expect(stale.ok).toBe(false);
      const afterStale = await harness.snapshot(InboxDoc, cid, ctx);
      expect((afterStale?.items ?? []).filter(isInputItem).map((item) => item.content)).toEqual([
        "second instruction",
        "first instruction",
      ]);

      // Unused helper guard for faux provider cleanliness.
      faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    } finally {
      await harness?.close(ctx);
      await storage.close(ctx);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
