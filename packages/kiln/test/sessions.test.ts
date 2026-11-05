import { describe, expect, test } from "bun:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  activeWorkerCeiling,
  briefTitle,
  crewEntryText,
  crewMessageRequestId,
  crewOutcome,
  crewReportText,
  DEFAULT_WORKER_ROLE,
  findCrewTarget,
  isActiveWorker,
  isUnsuccessful,
  nextRoleIndex,
  normalizeRole,
  ROLE_CAP,
  workerCapsText,
  workerCeilingRefusal,
  workerTitle,
  type CrewEntry,
} from "../src/sessions";

const worker = (overrides: Partial<CrewEntry> = {}): CrewEntry => ({
  kind: "worker",
  conversationId: 1 as ConversationId,
  title: "Worker #1",
  spawnedAt: 1,
  state: "reported",
  generation: 1,
  briefRequestId: "brief",
  ...overrides,
});

describe("worker role validation", () => {
  test("trims a role", () => {
    expect(normalizeRole("  Researcher  ")).toBe("Researcher");
    expect(normalizeRole("Graphics")).toBe("Graphics");
  });

  test("caps a long role", () => {
    expect(normalizeRole("R".repeat(120))).toBe("R".repeat(ROLE_CAP));
    expect(normalizeRole(`${"R".repeat(ROLE_CAP)}extra`)).toBe("R".repeat(ROLE_CAP));
    // Trimming happens before the cap, so padding cannot eat the label.
    expect(normalizeRole(`  ${"R".repeat(ROLE_CAP + 10)}  `)).toBe("R".repeat(ROLE_CAP));
  });

  test("rejects an empty or absent role", () => {
    expect(normalizeRole("")).toBeUndefined();
    expect(normalizeRole("   \n\t ")).toBeUndefined();
    expect(normalizeRole(undefined)).toBeUndefined();
  });
});

describe("worker role numbering", () => {
  test("the first spawn of a role is 1, the second is 2", () => {
    const items: Record<string, CrewEntry> = {};
    const first = nextRoleIndex(items, DEFAULT_WORKER_ROLE);
    expect(first).toBe(1);
    items.a = worker({ role: DEFAULT_WORKER_ROLE, roleIndex: first });
    expect(nextRoleIndex(items, DEFAULT_WORKER_ROLE)).toBe(2);
    items.b = worker({ role: DEFAULT_WORKER_ROLE, roleIndex: 2 });
    expect(nextRoleIndex(items, DEFAULT_WORKER_ROLE)).toBe(3);
  });

  test("a finished, stopped or archived worker keeps its number", () => {
    const items: Record<string, CrewEntry> = {
      done: worker({ role: "Researcher", roleIndex: 1, state: "reported" }),
      failed: worker({ role: "Researcher", roleIndex: 2, state: "failed" }),
      stopped: worker({ role: "Researcher", roleIndex: 3, state: "stopped" }),
    };
    expect(nextRoleIndex(items, "Researcher")).toBe(4);
  });

  test("roles number independently", () => {
    const items: Record<string, CrewEntry> = {
      a: worker({ role: "Researcher", roleIndex: 1 }),
      b: worker({ role: "Researcher", roleIndex: 2 }),
      c: worker({ role: "Graphics", roleIndex: 1 }),
    };
    expect(nextRoleIndex(items, "Researcher")).toBe(3);
    expect(nextRoleIndex(items, "Graphics")).toBe(2);
    expect(nextRoleIndex(items, "Reviewer")).toBe(1);
  });

  test("an explicit-title entry without a role does not consume a number", () => {
    const items: Record<string, CrewEntry> = { named: worker({ title: "My Agent" }) };
    expect(nextRoleIndex(items, DEFAULT_WORKER_ROLE)).toBe(1);
  });

  test("composes the title as <Role> #<n>", () => {
    expect(workerTitle("Researcher", 1)).toBe("Researcher #1");
    expect(workerTitle("Researcher", 12)).toBe("Researcher #12");
    expect(workerTitle(DEFAULT_WORKER_ROLE, 1)).toBe("Worker #1");
  });
});

describe("peer title fallback", () => {
  test("keeps the brief's first line, without heading marks", () => {
    expect(briefTitle("## Peer brief.\nMore detail.", "pal")).toBe("Peer brief.");
    expect(briefTitle("", "pal")).toBe("Session: pal");
  });
});

describe("a failed worker is not something to wait for", () => {
  const failed = worker({ state: "failed" });
  const reported = worker({ state: "reported" });
  const stopped = worker({ state: "stopped" });
  const running = worker({ state: "running" });
  const starting = worker({ state: "starting" });
  const peer = worker({ kind: "peer", state: "peer" });

  test("only starting and running workers are active", () => {
    expect(isActiveWorker(starting)).toBe(true);
    expect(isActiveWorker(running)).toBe(true);
    // The states a finished worker can reach all stop the wait.
    expect(isActiveWorker(reported)).toBe(false);
    expect(isActiveWorker(failed)).toBe(false);
    expect(isActiveWorker(stopped)).toBe(false);
    // A peer is not a worker; it reports to the user, never to the leader.
    expect(isActiveWorker(peer)).toBe(false);
  });

  test("failure and a stop are unsuccessful; a report is not", () => {
    expect(isUnsuccessful(failed)).toBe(true);
    expect(isUnsuccessful(stopped)).toBe(true);
    expect(isUnsuccessful(reported)).toBe(false);
    expect(isUnsuccessful(running)).toBe(false);
    expect(isUnsuccessful(peer)).toBe(false);
  });

  test("the crew outcome separates success, failure and still-running", () => {
    expect(crewOutcome({})).toBe("empty");
    expect(crewOutcome({ a: starting })).toBe("active");
    expect(crewOutcome({ a: reported, b: reported })).toBe("ok");
    expect(crewOutcome({ a: failed })).toBe("failed");
    // One failure makes the crew's answer incomplete even when another worker delivered.
    expect(crewOutcome({ a: reported, b: failed })).toBe("failed");
    expect(crewOutcome({ a: reported, b: stopped })).toBe("failed");
    // A still-running worker keeps the crew active even alongside a failure.
    expect(crewOutcome({ a: failed, b: running })).toBe("active");
  });

  test("a failed worker is labelled FAILED, never '(no report yet)'", () => {
    expect(crewEntryText("wk", failed)).toContain("FAILED");
    expect(crewEntryText("wk", failed)).toContain("Do not wait for it");
    expect(crewEntryText("wk", failed)).not.toContain("no report yet");
    expect(crewEntryText("wk", stopped)).toContain("STOPPED");
    expect(crewEntryText("wk", starting)).toContain("no report yet");
  });

  test("a report's own text wins over the state label", () => {
    const withReport = worker({
      state: "failed",
      report: { status: "failed", text: "upstream 500", at: 1, requestId: "r" },
    });
    const text = crewEntryText("wk", withReport);
    expect(text).toContain("upstream 500");
    expect(text).not.toContain("FAILED — this worker ended");
  });

  test("the crew summary lists newest spawn first and keeps every member", () => {
    const text = crewReportText({
      old: worker({ state: "reported", spawnedAt: 1, title: "Worker #1" }),
      new: worker({ state: "failed", spawnedAt: 2, title: "Worker #2" }),
    });
    expect(text.indexOf("Worker #2")).toBeLessThan(text.indexOf("Worker #1"));
    expect(text).toContain("FAILED");
    expect(crewReportText({})).toBe("No crew.");
  });
});

describe("crew name resolution", () => {
  const crew: Record<string, CrewEntry> = {
    researcher: worker({ conversationId: 7 as ConversationId, title: "Researcher #1", role: "Researcher", roleIndex: 1 }),
    graphics: worker({ conversationId: 8 as ConversationId, title: "Graphics #1", role: "Graphics", roleIndex: 1 }),
  };

  test("matches the crew key the leader spawned", () => {
    expect(findCrewTarget(crew, "researcher")?.entry.conversationId).toBe(7 as ConversationId);
  });

  test("matches the composed title, and ignores case", () => {
    expect(findCrewTarget(crew, "Graphics #1")?.key).toBe("graphics");
    expect(findCrewTarget(crew, "researcher #1")?.key).toBe("researcher");
    expect(findCrewTarget(crew, "  Graphics #1  ")?.key).toBe("graphics");
  });

  test("the exact crew key wins over a title that happens to match another entry", () => {
    const odd: Record<string, CrewEntry> = {
      "Graphics #1": worker({ conversationId: 9 as ConversationId, title: "Named by key" }),
      graphics: worker({ conversationId: 10 as ConversationId, title: "Graphics #1" }),
    };
    expect(findCrewTarget(odd, "Graphics #1")?.entry.conversationId).toBe(9 as ConversationId);
  });

  test("an absent or blank name resolves nothing", () => {
    expect(findCrewTarget(crew, "Researcher #2")).toBeUndefined();
    expect(findCrewTarget(crew, "")).toBeUndefined();
    expect(findCrewTarget(crew, "   ")).toBeUndefined();
    expect(findCrewTarget({}, "researcher")).toBeUndefined();
  });

  test("the message request id is stable per tool task and distinct per worker", () => {
    const first = crewMessageRequestId(1 as ConversationId, "researcher", 111, 900);
    expect(first).toBe(crewMessageRequestId(1 as ConversationId, "researcher", 111, 900));
    expect(first).not.toBe(crewMessageRequestId(1 as ConversationId, "researcher", 111, 901));
    expect(first).not.toBe(crewMessageRequestId(1 as ConversationId, "graphics", 222, 900));
    expect(first.startsWith("hearth.crew.msg:")).toBe(true);
  });
});

/**
 * The active-worker ceiling is off by default and settable per host, so the copy a model reads has to
 * follow whichever is in force — a tool description that promises a limit the code does not enforce is
 * the worst of both.
 */
describe('the active-worker ceiling', () => {
  const withEnv = (value: string | undefined, run: () => void) => {
    const previous = process.env.HEARTH_MAX_ACTIVE_WORKERS;
    if (value === undefined) delete process.env.HEARTH_MAX_ACTIVE_WORKERS;
    else process.env.HEARTH_MAX_ACTIVE_WORKERS = value;
    try {
      run();
    } finally {
      if (previous === undefined) delete process.env.HEARTH_MAX_ACTIVE_WORKERS;
      else process.env.HEARTH_MAX_ACTIVE_WORKERS = previous;
    }
  };

  test('no ceiling by default, however many are already running', () => {
    withEnv(undefined, () => {
      expect(activeWorkerCeiling()).toBe(0);
      for (const active of [0, 4, 12]) expect(workerCeilingRefusal(active)).toBeUndefined();
      expect(workerCapsText()).toContain('any number of workers');
    });
  });

  test('a ceiling applies when the host asks for one, and the copy says which', () => {
    withEnv('2', () => {
      expect(activeWorkerCeiling()).toBe(2);
      expect(workerCeilingRefusal(1)).toBeUndefined();
      expect(workerCeilingRefusal(2)).toContain('max 2');
      expect(workerCapsText()).toBe('at most 2 active workers');
    });
  });

  test('a junk or non-positive value means no ceiling rather than a surprise one', () => {
    for (const value of ['', '0', '-3', 'lots']) {
      withEnv(value, () => expect(activeWorkerCeiling()).toBe(0));
    }
  });
});

/**
 * A crew outlives the generation that raised it. These are the rules that keep a leader's answer
 * about the work it just asked for, not about the work a previous crew did.
 */
describe("crew generations", () => {
  const worker = (overrides: Partial<CrewEntry> = {}): CrewEntry => ({
    kind: "worker",
    conversationId: 1 as ConversationId,
    title: "Worker #1",
    spawnedAt: 1,
    state: "reported",
    generation: 1,
    briefRequestId: "brief",
    ...overrides,
  });

  test("a failure in an earlier generation does not fail this generation's outcome", () => {
    const items = {
      oldFailure: worker({ state: "failed", generation: 1 }),
      current: worker({ state: "reported", generation: 2 }),
    };
    // Whole-crew view: one failure anywhere makes the answer incomplete.
    expect(crewOutcome(items)).toBe("failed");
    // Scoped view: generation 2 delivered everything it was asked for.
    expect(crewOutcome(items, 2)).toBe("ok");
    expect(crewOutcome(items, 1)).toBe("failed");
    expect(crewOutcome(items, 3)).toBe("empty");
  });

  test("the summary a scoped wait reports lists only that generation", () => {
    const items = {
      oldFailure: worker({ state: "failed", generation: 1, title: "Old #1" }),
      current: worker({ state: "reported", generation: 2, title: "Current #1" }),
    };
    const scoped = crewReportText(items, 2);
    expect(scoped).toContain("Current #1");
    expect(scoped).not.toContain("Old #1");
    // The unscoped list is history, and history stays whole.
    expect(crewReportText(items)).toContain("Old #1");
  });
});
