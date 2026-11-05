import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  AGENT_MESSAGE_BUDGET,
  AgentsDoc,
  MAX_MIRROR_AGENTS,
  agentMessageRateLimited,
  agentsMdSection,
  agentsMirrorPath,
  createAgentsMdSection,
  createAgentsTool,
  formatForeignAgentMessage,
  listAgents,
  mergeDirectory,
  readAgentsMirror,
  registerAgent,
  renderKnownAgents,
  staleAgentNames,
  writeAgentsMirror,
  type AgentEntry,
} from '../src/agents';
import { hearthRegistry } from '../src/registry';
import { SessionsDoc, type CrewEntry } from '../src/sessions';
import { MetaDoc } from '../src/meta';

const context = BACKGROUND_CONTEXT;

const entry = (conversationId: number, overrides: Partial<AgentEntry> = {}): AgentEntry => ({
  conversationId,
  host: 'local',
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

test('the agents-md section renders the cwd AGENTS.md into the prompt, and falls back to home AGENTS.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-agents-'));
  const home = mkdtempSync(join(tmpdir(), 'hearth-home-'));
  const emptyCwd = mkdtempSync(join(tmpdir(), 'hearth-empty-'));
  writeFileSync(join(dir, 'AGENTS.md'), '# Project rules\nDo the thing.\n');
  writeFileSync(join(home, 'AGENTS.md'), '# Default home guide\nUse Playwright and tools.\n');
  try {
    const sectionWithHome = createAgentsMdSection(home);
    // Project AGENTS.md wins when present.
    const rendered = sectionWithHome.render({ agent: { cwd: dir } } as never, BACKGROUND_CONTEXT);
    expect(String(rendered)).toContain('Do the thing.');
    // When project folder has no AGENTS.md, falls back to <home>/AGENTS.md.
    const fallback = sectionWithHome.render({ agent: { cwd: emptyCwd } } as never, BACKGROUND_CONTEXT);
    expect(String(fallback)).toContain('Use Playwright and tools.');
    // No cwd and no home renders nothing.
    expect(agentsMdSection.render({ agent: {} } as never, BACKGROUND_CONTEXT)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(emptyCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('the registry installs the agents-md section and the agents extension', () => {
  const snapshot = hearthRegistry().snapshot();
  expect(snapshot.sections().some((entry) => entry.extension.name === 'agents-md')).toBe(true);
  expect(snapshot.extension('agents')).toBeDefined();
  expect(snapshot.tools().some((entry) => entry.tool.name === 'agents')).toBe(true);
});

describe('known_agents formatting', () => {
  const entries = {
    pinned: entry(1, { pinned: true, updatedAt: 2, description: 'keep\nthis short' }),
    newest: entry(2, { updatedAt: 30, description: 'newest' }),
    second: entry(3, { updatedAt: 20, description: 'second' }),
    third: entry(4, { updatedAt: 10, description: 'third' }),
    fourth: entry(5, { updatedAt: 5, description: 'fourth' }),
  };

  test('renders pinned plus the three most recently updated, one line each', () => {
    const rendered = renderKnownAgents(entries);
    expect(rendered).toBeDefined();
    expect(rendered).toContain('pinned (local, pinned) — keep this short');
    expect(rendered).toContain('newest (local) — newest');
    expect(rendered).toContain('second (local) — second');
    expect(rendered).toContain('third (local) — third');
    // The fourth recent agent is beyond the bound.
    expect(rendered).not.toContain('fourth');
    // A newline in a description can never break the one-line contract.
    expect(rendered).not.toContain('keep\nthis');
  });

  test('renders nothing for an absent or empty registry', () => {
    expect(renderKnownAgents(undefined)).toBeUndefined();
    expect(renderKnownAgents({})).toBeUndefined();
  });
});

describe('directory merge', () => {
  test('omits gone and archived conversations, sorts pinned first then newest activity, and identifies stale rows', () => {
    const listed = listAgents({
      entries: {
        old: entry(1, { updatedAt: 1 }),
        pinned: entry(2, { pinned: true, updatedAt: 2 }),
        fresh: entry(3, { updatedAt: 9 }),
        archivedRow: entry(4, { updatedAt: 50 }),
        gone: entry(999, { updatedAt: 100 }),
      },
    });
    const summaries = new Map([
      [1, { title: 'Old', lastActivity: 5 }],
      [2, { title: 'Pinned', lastActivity: 2 }],
      [3, { title: 'Fresh', lastActivity: 50 }],
      [4, { title: 'Archived', archived: 12345, lastActivity: 60 }],
    ]);
    const merged = mergeDirectory(listed, summaries);
    expect(merged.map((agent) => agent.name)).toEqual(['pinned', 'fresh', 'old']);
    expect(staleAgentNames(listed, summaries).sort()).toEqual(['archivedRow', 'gone']);
  });
});

describe('agent mirror', () => {
  test('round-trips through <home>/agents.json, bounds size by recency, and tolerates a missing file', () => {
    const home = mkdtempSync(join(tmpdir(), 'hearth-mirror-'));
    try {
      expect(readAgentsMirror(home)).toBeUndefined();
      writeAgentsMirror(home, { entries: { Improver: entry(7, { pinned: true, description: 'improve' }) } });
      const read = readAgentsMirror(home);
      expect(read?.Improver).toMatchObject({ conversationId: 7, host: 'local', pinned: true });
      expect(JSON.parse(readFileSync(agentsMirrorPath(home), 'utf8')).entries.Improver.conversationId).toBe(7);

      // Bounds the mirror to MAX_MIRROR_AGENTS by recency.
      const many: Record<string, AgentEntry> = {};
      for (let i = 0; i < MAX_MIRROR_AGENTS + 25; i += 1) {
        many[`agent-${i}`] = entry(i + 1, { updatedAt: i });
      }
      writeAgentsMirror(home, { entries: many });
      const bounded = readAgentsMirror(home) ?? {};
      expect(Object.keys(bounded)).toHaveLength(MAX_MIRROR_AGENTS);
      expect(bounded['agent-0']).toBeUndefined();
      expect(bounded[`agent-${MAX_MIRROR_AGENTS + 24}`]).toBeDefined();

      // Malformed JSON renders nothing rather than throwing into a prompt render.
      writeFileSync(agentsMirrorPath(home), '{nope');
      expect(readAgentsMirror(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('agents tool', () => {
  test('send is idempotent across a tool rerun, and pin/unpin refreshes the mirror', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hearth-agents-tool-'));
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxText('ack one')]),
      fauxAssistantMessage([fauxText('ack two')]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const storage = await openNodeSqliteStorage(join(directory, 'hearth.sqlite'));
    const harness = await Harness.open(
      storage,
      {
        models,
        registry: createRegistry(),
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
      },
      context
    );
    try {
      const sender = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
      const target = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
      await harness.commit(
        (tx) =>
          registerAgent(tx, 'Recipient', {
            conversationId: target.id as number,
            host: 'local',
            description: 'takes messages',
            pinned: false,
            createdAt: 1,
            updatedAt: 1,
          }),
        context
      );

      const tool = createAgentsTool(directory);
      const api = {
        taskId: 4242,
        conversationId: sender.id,
        // Two-argument snapshot is the session-scoped registry; three is a conversation doc.
        snapshot: (token: any, first: any, second?: any) =>
          second === undefined ? harness.snapshot(token, first) : harness.snapshot(token, first, second),
        conversation: (id: any, ctx: any) => harness.conversation(id, ctx),
        commit: (change: any, ctx: any) => harness.commit(change, ctx),
      } as any;

      // The same tool task rerun derives the same requestId, so it reacquires the submission.
      await tool.execute({ action: 'send', name: 'Recipient', message: 'RERUN_MARKER' }, api, context);
      await tool.execute({ action: 'send', name: 'Recipient', message: 'RERUN_MARKER' }, api, context);
      const page = await (await harness.conversation(target.id, context))!.entries({}, 50, undefined, context);
      const delivered = page.items.filter(
        (item) =>
          item.kind === 'pi.user' &&
          (item.model?.[0] as { content?: unknown } | undefined)?.content === 'RERUN_MARKER'
      );
      expect(delivered).toHaveLength(1);

      // An unknown name fails helpfully rather than posting anywhere.
      const unknown = await tool.execute({ action: 'send', name: 'Ghost', message: 'hello' }, api, context);
      const text = (unknown.output?.[0] as { text?: string } | undefined)?.text ?? '';
      expect(text).toContain('No agent named Ghost');

      // Pin then unpin: the durable doc changes and the mirror file follows.
      await tool.execute({ action: 'pin', name: 'Recipient' }, api, context);
      expect(readAgentsMirror(directory)?.Recipient.pinned).toBe(true);
      const pinnedOrder = listAgents(await harness.snapshot(AgentsDoc, context));
      expect(pinnedOrder[0].name).toBe('Recipient');
      await tool.execute({ action: 'unpin', name: 'Recipient' }, api, context);
      expect(readAgentsMirror(directory)?.Recipient.pinned).toBe(false);

      // Lazily prunes archived or gone conversations on `directory` read inside one commit.
      await harness.commit(async (tx) => {
        await registerAgent(tx, 'GoneRow', entry(99999));
        const meta = await tx.doc(MetaDoc, target.id);
        meta.archived = 12345;
      }, context);
      writeAgentsMirror(directory, await harness.snapshot(AgentsDoc, context));
      expect(readAgentsMirror(directory)?.GoneRow).toBeDefined();
      await tool.execute({ action: 'directory' }, api, context);
      const afterPrune = await harness.snapshot(AgentsDoc, context);
      expect(afterPrune?.entries.GoneRow).toBeUndefined();
      expect(afterPrune?.entries.Recipient).toBeUndefined();
      expect(readAgentsMirror(directory)?.GoneRow).toBeUndefined();
      expect(readAgentsMirror(directory)?.Recipient).toBeUndefined();
    } finally {
      await harness.close(context);
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Windows holds the sqlite handle for a moment after close; a leftover temp dir is not a failure.
      }
    }
  }, 20_000);
});

describe('agents tool crew messaging', () => {
  /** A leader's crew entry for one target conversation. */
  const crewEntry = (conversationId: number, title: string, spawnedAt = 111): CrewEntry => ({
    kind: 'worker',
    conversationId: conversationId as never,
    title,
    role: title.split(' #')[0],
    roleIndex: 1,
    spawnedAt,
    state: 'running',
    generation: 1,
    briefRequestId: `brief-${conversationId}`,
  });

  const textOf = (result: { output?: unknown }): string =>
    ((result.output as { text?: string }[] | undefined) ?? []).map((part) => part.text ?? '').join('\n');

  const userTexts = async (
    harness: Harness,
    id: number
  ): Promise<string[]> => {
    const handle = await harness.conversation(id as never, context);
    if (!handle) return [];
    const page = await handle.entries({}, 100, undefined, context);
    return page.items
      .filter((item) => item.kind === 'pi.user')
      .map((item) => {
        const content = (item.model?.[0] as { content?: unknown } | undefined)?.content;
        return typeof content === 'string' ? content : '';
      });
  };

  test("reaches the leader's own crew first, refuses another leader's worker, and keeps the unknown reply", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hearth-agents-crew-'));
    const faux = fauxProvider();
    // One answer per send that lands (the refused and unknown sends place nothing).
    faux.setResponses([
      fauxAssistantMessage([fauxText('crew one')]),
      fauxAssistantMessage([fauxText('crew two')]),
      fauxAssistantMessage([fauxText('crew three')]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const storage = await openNodeSqliteStorage(join(directory, 'hearth.sqlite'));
    const harness = await Harness.open(
      storage,
      {
        models,
        registry: createRegistry(),
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
      },
      context
    );
    try {
      const open = async (): Promise<number> =>
        (await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)).id as number;
      const leader = await open();
      const worker = await open();
      const otherLeader = await open();
      const otherWorker = await open();
      await harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc, leader as never)).items.researcher = crewEntry(worker, 'Researcher #1');
        (await tx.doc(SessionsDoc, otherLeader as never)).items.graphics = crewEntry(
          otherWorker,
          'Graphics #1',
          222
        );
        const otherMeta = await tx.doc(MetaDoc, otherWorker as never);
        otherMeta.kind = 'worker';
        otherMeta.lead = { conversationId: otherLeader as never, host: 'local' };
      }, context);

      const tool = createAgentsTool(directory);
      const api = {
        taskId: 1,
        conversationId: leader as never,
        // Two-argument snapshot is the session-scoped registry; three is a conversation doc.
        snapshot: (token: any, first: any, second?: any) =>
          second === undefined ? harness.snapshot(token, first) : harness.snapshot(token, first, second),
        conversation: (id: any, ctx: any) => harness.conversation(id, ctx),
        commit: (change: any, ctx: any) => harness.commit(change, ctx),
      } as any;

      // Addressed by the worker's composed title: the crew wins before the registry.
      const sent = await tool.execute(
        { action: 'send', name: 'Researcher #1', message: 'CREW_STEER' },
        { ...api, taskId: 11 },
        context
      );
      expect(textOf(sent)).toBe('Sent to Researcher #1.');

      // followUp queues it for a busy worker, and says so.
      const queued = await tool.execute(
        { action: 'send', name: 'researcher', message: 'CREW_QUEUE', followUp: true },
        { ...api, taskId: 12 },
        context
      );
      expect(textOf(queued)).toBe('Queued for Researcher #1.');

      // Both landed in the worker's conversation, in the order they were sent.
      let delivered: string[] = [];
      for (let attempt = 0; attempt < 200; attempt += 1) {
        delivered = await userTexts(harness, worker);
        if (delivered.includes('CREW_QUEUE')) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(delivered).toContain('CREW_STEER');
      expect(delivered).toContain('CREW_QUEUE');

      // A worker of another leader is refused and receives nothing.
      const foreign = await tool.execute(
        { action: 'send', name: 'Graphics #1', message: 'NOPE_MARKER' },
        { ...api, taskId: 13 },
        context
      );
      const foreignText = textOf(foreign);
      expect(foreignText).toContain('Refused');
      expect(foreignText).toContain("another leader's crew");
      expect(foreignText).toContain(String(otherLeader));
      expect(await userTexts(harness, otherWorker)).not.toContain('NOPE_MARKER');

      // A genuinely unknown name keeps the directory reply, including the registry policy.
      const unknown = await tool.execute(
        { action: 'send', name: 'Ghost', message: 'hello' },
        { ...api, taskId: 14 },
        context
      );
      expect(textOf(unknown)).toContain('No agent named Ghost');
      expect(textOf(unknown)).toContain('Only a human can register an agent.');
    } finally {
      await harness.close(context);
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Windows holds the sqlite handle for a moment after close; a leftover temp dir is not a failure.
      }
    }
  }, 20_000);

  test('federates send across hosts, labels foreign messages, and enforces the 60/hour budget', async () => {
    const now = Date.now();
    expect(agentMessageRateLimited(Array.from({ length: AGENT_MESSAGE_BUDGET }, () => now - 1000), now)).toBe(true);
    expect(agentMessageRateLimited(Array.from({ length: AGENT_MESSAGE_BUDGET - 1 }, () => now - 1000), now)).toBe(false);
    expect(formatForeignAgentMessage('Tower', 'Lazy Librarian', 'Ping')).toBe(
      '[Message from agent Tower/Lazy Librarian]:\nPing'
    );

    const directory = mkdtempSync(join(tmpdir(), 'hearth-agents-fed-'));
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage([fauxText('ack')])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const storage = await openNodeSqliteStorage(join(directory, 'hearth.sqlite'));
    const harness = await Harness.open(
      storage,
      {
        models,
        registry: createRegistry(),
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
      },
      context
    );
    const receivedBodies: unknown[] = [];
    const peerServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/directory') {
          return Response.json({
            agents: [
              {
                name: 'Archivist',
                host: 'local',
                conversationId: 77,
                title: 'Archivist',
                busy: false,
                needsInput: false,
                pinned: true,
              },
            ],
          });
        }
        if (url.pathname === '/directory/send' && req.method === 'POST') {
          receivedBodies.push(await req.json());
          return Response.json({ ok: true, name: 'Archivist', conversationId: 77 }, { status: 201 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const sender = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
      await harness.commit(async (tx) => {
        const meta = await tx.doc(MetaDoc, sender.id);
        meta.title = 'Curious Mechanic';
        const doc = await tx.doc(AgentsDoc);
        doc.peers = [
          {
            id: 'pi:tower',
            label: 'Tower',
            url: `http://127.0.0.1:${peerServer.port}`,
            token: 'peer-secret-token',
          },
        ];
      }, context);

      const tool = createAgentsTool(directory);
      const api = {
        taskId: 99,
        conversationId: sender.id,
        snapshot: (token: any, first: any, second?: any) =>
          second === undefined ? harness.snapshot(token, first) : harness.snapshot(token, first, second),
        conversation: (id: any, ctx: any) => harness.conversation(id, ctx),
        commit: (change: any, ctx: any) => harness.commit(change, ctx),
      } as any;

      const res = await tool.execute(
        { action: 'send', name: 'Archivist', message: 'Check the schema' },
        api,
        context
      );
      expect(textOf(res)).toBe('Sent to Tower/Archivist.');
      expect(receivedBodies).toHaveLength(1);
      expect(receivedBodies[0]).toMatchObject({
        name: 'Archivist',
        message: 'Check the schema',
        senderName: 'Curious Mechanic',
      });
    } finally {
      peerServer.stop(true);
      await harness.close(context);
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // ignore cleanup race
      }
    }
  }, 20_000);
});
