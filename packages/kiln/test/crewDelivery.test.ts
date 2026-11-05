/**
 * `report: "on-failure"` — a brief whose expected answer is "done, nothing to say".
 *
 * The supervisor used to write a report for every settled worker: a transcript entry, a line in the
 * wake digest, and a leader turn paraphrasing it. For a worker told "run the tests" whose answer is
 * "all 64 pass", that is three artefacts for one bit. With `on-failure` a success settles silently —
 * the crew doc still says `reported`, so `list` and the crew strip draw it, and `results` still has
 * the text — while a failure is announced exactly as before. The rule is: the leader asked not to be
 * interrupted by good news, not to be kept in the dark about bad news.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
  LiveDoc,
  configure,
  createRegistry,
  Harness,
  type Harness as HarnessType,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Sessions, SessionsDoc, crewEntryText, type CrewEntry, type SessionsState } from "../src/sessions";
import { MetaDoc } from "../src/meta";
import { digestOf, hasVisibleReport, tick } from "../src/crew";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" } as const;

const openHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "hearth-report-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Sessions);
  const storage = await openNodeSqliteStorage(join(directory, "hearth.sqlite"));
  const harness = await Harness.open(
    storage,
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  harness.resume();
  return { harness, storage, faux, directory };
};

const agent = async (harness: HarnessType, cwd: string, meta: Record<string, unknown> = {}) => {
  const record = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  await harness.commit(async (tx) => {
    await configure(tx, record.id, { model, cwd });
    Object.assign(await tx.doc(MetaDoc, record.id), meta);
  }, context);
  return record;
};

/** A worker that has just answered: an assistant turn landed since its task was handed over. */
const seedAnsweredWorker = async (
  harness: HarnessType,
  leaderId: number,
  workerId: number,
  workerCwd: string,
  overrides: Partial<CrewEntry> = {}
) => {
  void workerCwd;
  await harness.commit(async (tx) => {
    // The worker's transcript: a brief, then the assistant turn that answers it. That pair is what
    // the supervisor reads to decide "settled and answered".
    await tx.appendEntry(workerId as never, { kind: "pi.user", model: [fauxAssistantMessage([fauxText("Run the tests.")])] });
    await tx.appendEntry(workerId as never, {
      kind: "pi.assistant",
      model: [fauxAssistantMessage([fauxText("All 64 tests pass.")])],
    });
    const doc = await tx.doc(SessionsDoc, leaderId as never);
    doc.generation = 1;
    doc.deadlineAt = Date.now() + 60_000;
    doc.items["tester"] = {
      kind: "worker",
      conversationId: workerId as never,
      title: "Tester #1",
      role: "Tester",
      roleIndex: 1,
      spawnedAt: Date.now() - 60_000,
      state: "running",
      generation: 1,
      briefRequestId: "brief-1",
      ...overrides,
    };
  }, context);
};

const crewReportEntries = async (harness: HarnessType, leaderId: number) => {
  const entries = await (await harness.conversation(leaderId as never, context))!.entries({}, 50, undefined, context);
  return entries.items.filter((entry) => entry.kind === "hearth.crew-report");
};

const crewWakes = async (harness: HarnessType, leaderId: number): Promise<string[]> => {
  const entries = await (await harness.conversation(leaderId as never, context))!.entries({}, 50, undefined, context);
  return entries.items
    .filter((entry) => entry.kind === "pi.user")
    .map((entry) => {
      const content = (entry.model as any)?.[0]?.content;
      return typeof content === "string" ? content : JSON.stringify(content ?? "");
    })
    .filter((text) => text.startsWith("[crew] Crew report"));
};

/** The pure part: what a leader asking `results` reads for one worker. */
const entry = (over: Partial<CrewEntry> = {}): CrewEntry => ({
  kind: "worker",
  conversationId: 2 as never,
  title: "Tester #1",
  spawnedAt: 0,
  state: "reported",
  generation: 1,
  briefRequestId: "b",
  ...over,
});

describe("what a silent success says", () => {
  test("`results` still answers with the text, rather than looking unanswered", () => {
    // The leader opted out of being *interrupted*; it did not give up the ability to ask.
    const silent = entry({ delivery: "on-failure", silentReport: { text: "All 64 tests pass.", at: 1 } });
    expect(crewEntryText("tester", silent)).toContain("All 64 tests pass.");
    expect(crewEntryText("tester", silent)).not.toContain("no report yet");
  });

  test("a shown report wins over a stale silent one", () => {
    const both = entry({
      delivery: "on-failure",
      silentReport: { text: "an earlier success", at: 1 },
      report: { status: "failed", text: "This worker failed: timeout", at: 2, requestId: "r" },
    });
    expect(crewEntryText("tester", both)).toContain("This worker failed");
    expect(crewEntryText("tester", both)).not.toContain("an earlier success");
  });

  test("the digest says nothing about a worker with no report", () => {
    // `wakeKeyOf` and the digest read `report`; a silent success has none, which is what keeps it out
    // of the wake while leaving the state visible.
    const state = { generation: 1, items: { tester: entry({ delivery: "on-failure", silentReport: { text: "ok", at: 1 } }) }, spawnedAt: [] };
    expect(digestOf(state)).toContain("(no report yet)");
    expect(digestOf(state)).not.toContain("All 64 tests pass");
  });

  test("an entry written before the field existed reads as `always`", () => {
    // Absent means always: an upgraded host must not retroactively silence a running crew.
    expect(entry().delivery).toBeUndefined();
  });
});

describe("the supervisor under `on-failure`", () => {
  test('a success settles without a report entry, a wake line or a wake', async () => {
    const isolated = await openHarness();
    try {
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      // The worker answered already: its newest assistant entry is what the supervisor reads.
      await seedAnsweredWorker(
        isolated.harness,
        leader.id as unknown as number,
        worker.id as unknown as number,
        isolated.directory,
        { delivery: "on-failure" }
      );

      await tick(isolated.harness, isolated.storage, context);

      const state = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      const item = state?.items["tester"];
      // Settled, and visibly so — `list` and the crew strip read `state`.
      expect(item?.state === "reported" || item?.state === "failed").toBe(true);
      // Nothing was written into the transcript for a success...
      const entries = await crewReportEntries(isolated.harness, leader.id);
      if (item?.state === "reported") {
        expect(entries).toHaveLength(0);
        expect(item?.silentReport?.text.trim().length).toBeGreaterThan(0);
        expect(item?.report).toBeUndefined();
        // ...and the leader was not woken for it.
        expect(await crewWakes(isolated.harness, leader.id)).toHaveLength(0);
      }
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  test("a failure is announced exactly as before", async () => {
    const isolated = await openHarness();
    try {
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      // No assistant turn at all: this worker can never answer, which the supervisor reports as a
      // failure ("never started"). `on-failure` must not silence that.
      await seedAnsweredWorker(
        isolated.harness,
        leader.id as unknown as number,
        worker.id as unknown as number,
        isolated.directory,
        { delivery: "on-failure", spawnedAt: Date.now() - 60_000 }
      );
      await isolated.harness.commit(async (tx) => {
        const doc = await tx.doc(SessionsDoc, leader.id as never);
        const item = doc.items["tester"];
        if (item) item.state = "starting";
      }, context);

      await tick(isolated.harness, isolated.storage, context);
      const state = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      const item = state?.items["tester"];
      if (item?.state === "failed") {
        expect(item.report).toBeDefined();
        expect(item.silentReport).toBeUndefined();
        expect((await crewReportEntries(isolated.harness, leader.id)).length).toBeGreaterThan(0);
      }
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});

/**
 * The risk of a silent crew is a crew that says nothing when it goes wrong.
 *
 * `hasVisibleReport` gates the quiescence wake. A generation of `on-failure` workers that all
 * succeeded has nothing to show and should not interrupt. One that *failed* has a report, and must
 * wake its leader exactly as before — this is the line the guard must not cross.
 */
describe("the quiet-wake guard", () => {
  const base = (): SessionsState => ({
    generation: 1,
    items: {},
    spawnedAt: [],
  });

  test("a generation of silent successes has nothing to wake for", () => {
    const state = base();
    state.items["tester"] = entry({
      delivery: "on-failure",
      state: "reported",
      silentReport: { text: "All 64 tests pass.", at: 1 },
    });
    expect(hasVisibleReport(state)).toBe(false);
  });

  test("one failure is enough to wake", () => {
    const state = base();
    state.items["tester"] = entry({
      delivery: "on-failure",
      state: "reported",
      silentReport: { text: "All 64 tests pass.", at: 1 },
    });
    state.items["linter"] = entry({
      delivery: "on-failure",
      state: "failed",
      report: { status: "failed", text: "This worker failed: timeout", at: 2, requestId: "r" },
    });
    expect(hasVisibleReport(state)).toBe(true);
  });

  test("a generation with no on-failure policy at all is unaffected", () => {
    const state = base();
    state.items["tester"] = entry({
      state: "reported",
      report: { status: "ok", text: "done", at: 1, requestId: "r" },
    });
    expect(hasVisibleReport(state)).toBe(true);
  });

  test("a worker from an earlier generation does not count", () => {
    // The wake is per generation: a failure two crews ago is history, not news.
    const state = base();
    state.items["old"] = entry({
      state: "failed",
      generation: 0,
      report: { status: "failed", text: "old failure", at: 1, requestId: "r" },
    });
    expect(hasVisibleReport(state)).toBe(false);
  });
});
