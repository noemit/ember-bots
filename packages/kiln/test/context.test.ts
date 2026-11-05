import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import {
  CONTEXT_PREAMBLE,
  createContextRule,
  injectContextForInput,
  matchingRules,
  parseContextRuleInput,
  parseContextRulePatch,
  type ContextRule,
} from '../src/context';

const context = BACKGROUND_CONTEXT;
let home: string;
let harness: Harness;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'hearth-context-'));
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText('ok')])]);
  const models = createModels();
  models.setProvider(faux.provider);
  harness = await Harness.open(
    await openNodeSqliteStorage(join(home, 'hearth.sqlite')),
    { models, registry: createRegistry(), env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  harness.resume();
});

afterAll(async () => {
  await harness.close(context);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

describe('context rules', () => {
  test('parseContextRuleInput validates keywords and text', () => {
    expect(parseContextRuleInput({})).toBeNull();
    expect(parseContextRuleInput({ keywords: ['x'], text: '' })).toBeNull();
    expect(parseContextRuleInput({ keywords: [' vedic '], text: 'use vedic rules' })).toEqual({
      keywords: ['vedic'],
      text: 'use vedic rules',
      enabled: true,
    });
    expect(parseContextRulePatch({ enabled: false })).toEqual({ enabled: false });
  });

  test('matchingRules matches enabled keywords case-insensitively', () => {
    const rules: ContextRule[] = [
      { id: 'a', keywords: ['vedic'], text: 't', enabled: true, createdAt: 0 },
      { id: 'b', keywords: ['seo'], text: 't', enabled: false, createdAt: 0 },
    ];
    expect(matchingRules(rules, 'Tell me about VEDIC today').map((rule) => rule.id)).toEqual(['a']);
    expect(matchingRules(rules, 'nothing here')).toEqual([]);
  });

  test('a matching rule reaches the model, framed so it is not a human turn', async () => {
    await createContextRule(harness, { keywords: ['vedic'], text: 'Use the Vedic project rules.', enabled: true }, context);
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    const fired = await injectContextForInput(harness, conversation.id, 'go into the vedic folder', context);
    expect(fired).toHaveLength(1);

    // The property that was broken: the rule text is in what the model is actually sent. Asserting
    // that an entry exists is what let this feature stay inert for a year — a `data`-only entry is
    // written, listed and hidden by the transcript, and contributes nothing to the request.
    const { messages } = await conversation.context(context);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    const sent = JSON.stringify(messages[0]);
    expect(sent).toContain('Use the Vedic project rules.');
    expect(sent).toContain(CONTEXT_PREAMBLE);

    // And the transcript still skips it: the entry keeps the kind and data a client filters on.
    const entries = (await conversation.entries({}, 10, undefined, context)).items;
    const injected = entries.find((entry) => entry.kind === 'hearth.context');
    expect(injected?.data).toEqual({ ruleId: fired[0], text: 'Use the Vedic project rules.' });
  });

  test('two rules matching one message both reach the model', async () => {
    await createContextRule(harness, { keywords: ['seo'], text: 'Follow the SEO checklist.', enabled: true }, context);
    await createContextRule(harness, { keywords: ['launch'], text: 'The launch is on the 3rd.', enabled: true }, context);
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    const fired = await injectContextForInput(harness, conversation.id, 'seo for the launch page', context);
    expect(fired).toHaveLength(2);
    const { messages } = await conversation.context(context);
    const sent = JSON.stringify(messages);
    expect(sent).toContain('Follow the SEO checklist.');
    expect(sent).toContain('The launch is on the 3rd.');
  });

  test('a message that matches nothing writes nothing at all', async () => {
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    expect(await injectContextForInput(harness, conversation.id, 'hello there', context)).toEqual([]);
    expect((await conversation.entries({}, 10, undefined, context)).items).toEqual([]);
    expect((await conversation.context(context)).messages).toEqual([]);
  });
});
