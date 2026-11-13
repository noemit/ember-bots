import { describe, expect, test } from 'bun:test';
import {
  applyLiveToolOutput,
  liveToolOutputs,
  piApprovalToPermissionRequest,
  piConversationToSession,
  piEntriesToMessages,
  piInboxToQueuedMessages,
  piModelsToModelList,
  piQuestionToQuestionRequest,
  extractNestedCalls,
  entryOrdinal,
  LIVE_MESSAGE_ID,
  newestEntryId,
  settleToolResults,
  type PiEntry,
} from '../src/lib/piMapping';
import type { ChatMessage } from '../src/types';

const assistant = (content: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  role: 'assistant',
  content,
  provider: 'opencode-go',
  model: 'glm-5.3-flash',
  usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, cost: { total: 0.002 } },
  stopReason: 'stop',
  timestamp: 1_000,
  ...extra,
});

describe('a running call, with its output patched from the live slot', () => {
  const call = (extra: Record<string, unknown> = {}) => [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'grep -c RC= log' } }],
      ...extra,
    },
  ];
  const live = (status: 'pending' | 'running' | 'done', output?: string) => ({
    tools: [{ callId: 'call_1', name: 'bash', status, ...(output === undefined ? {} : { output }) }],
  });

  test('the slot carries what the command has written so far', () => {
    expect(liveToolOutputs(live('running', 'a\nb'))).toEqual([{ callId: 'call_1', output: 'a\nb' }]);
  });

  test('a slot with no output says nothing, rather than an empty row', () => {
    expect(liveToolOutputs(live('running'))).toEqual([]);
    expect(liveToolOutputs(live('running', ''))).toEqual([]);
    expect(liveToolOutputs(undefined)).toEqual([]);
  });

  test('an incremental page with no entries still updates the call already held', () => {
    // The whole reason this exists: a `since` read during a running command is normally *empty*,
    // so mapping it produced nothing and the output never reached the row on screen.
    const held = piEntriesToMessages([{ id: 1, kind: 'pi.assistant', model: call() }], live('running'));
    const next = applyLiveToolOutput(held, [{ callId: 'call_1', output: 'waiting\nRC=0\n' }]);
    const part = next[0].parts[0];
    expect(part.type).toBe('tool');
    if (part.type !== 'tool') throw new Error('unreachable');
    expect(part.call.status).toBe('running');
    expect(part.call.output).toBe('waiting\nRC=0\n');
  });

  test('output arriving for a call drawn as pending makes it running', () => {
    // The call was mapped before its slot existed; the first chunk is proof that it is executing.
    const held = piEntriesToMessages([{ id: 1, kind: 'pi.assistant', model: call() }]);
    const part = applyLiveToolOutput(held, [{ callId: 'call_1', output: 'x' }])[0].parts[0];
    if (part.type !== 'tool') throw new Error('unreachable');
    expect(part.call.status).toBe('running');
  });

  test('a settled call is never resurrected by a stale slot', () => {
    const held = piEntriesToMessages([{ id: 1, kind: 'pi.assistant', model: call() }], live('running'));
    const settled = settleToolResults(held, [{ callId: 'call_1', status: 'completed', output: 'final' }]);
    const after = applyLiveToolOutput(settled, [{ callId: 'call_1', output: 'stale tail' }]);
    const part = after[0].parts[0];
    if (part.type !== 'tool') throw new Error('unreachable');
    expect(part.call.status).toBe('completed');
    expect(part.call.output).toBe('final');
  });

  test('nothing to change returns the same array, so a poll cannot churn the column', () => {
    const held = piEntriesToMessages([{ id: 1, kind: 'pi.assistant', model: call() }], live('running', 'same'));
    expect(applyLiveToolOutput(held, [])).toBe(held);
    expect(applyLiveToolOutput(held, [{ callId: 'call_1', output: 'same' }])).toBe(held);
    // A call this transcript does not hold is not an error, and not a change either.
    expect(applyLiveToolOutput(held, [{ callId: 'other', output: 'x' }])).toBe(held);
  });
});

describe('conversation → session', () => {
  test('an unset Kiln thinking setting resolves to off without inventing levels for old replies', () => {
    const session = piConversationToSession('hearth', {
      id: 42, model: { provider: 'deepseek', modelId: 'deepseek-flash' },
    });
    expect(session.model?.variant).toBe('off');
    const [historical] = piEntriesToMessages([
      { id: 1, kind: 'pi.assistant', model: [assistant([{ type: 'text', text: 'An older reply.' }])] },
    ]);
    expect(historical.model?.variant).toBeUndefined();
  });
  test('maps ids, cwd, model, title, archive and task ownership', () => {
    const session = piConversationToSession('hearth', {
      id: 42,
      cwd: '/workspace/habit',
      title: 'QA',
      archived: 123,
      model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' },
      thinkingLevel: 'high',
      updatedAt: 999,
      owner: { conversationId: 7, taskId: 3 },
    });
    expect(session.id).toBe('42');
    expect(session.instanceId).toBe('hearth');
    expect(session.directory).toBe('/workspace/habit');
    expect(session.title).toBe('QA');
    expect(session.archived).toBe(123);
    expect(session.updated).toBe(999);
    expect(session.model).toEqual({ providerID: 'opencode-go', modelID: 'glm-5.3-flash', variant: 'high' });
    expect(session.parentId).toBe('7');
    // A fork's `parent` is history ancestry, not a subagent parent.
    expect(piConversationToSession('hearth', { id: 1, parent: { conversationId: 2, at: 9 } }).parentId).toBeUndefined();
  });

  test('carries the session spend the host reports, and leaves it absent when it does not', () => {
    // The rail shows this as a chip and the view menu as a data line, without reading a transcript.
    expect(piConversationToSession('hearth', { id: 7, cost: 1.2345 }).cost).toBe(1.2345);
    // An older host sends no cost; the chip must disappear rather than claim zero.
    expect(piConversationToSession('hearth', { id: 7 }).cost).toBeUndefined();
  });

  test('carries the newest entry id, which is how Home knows a session may hold unread messages', () => {
    expect(piConversationToSession('hearth', { id: 7, lastEntryId: 41 }).lastEntryId).toBe(41);
    // Absent when the host says nothing: Home must not read 0 as "nothing new since the beginning".
    expect(piConversationToSession('hearth', { id: 7 }).lastEntryId).toBeUndefined();
  });

  test('maps the crew fields: kind, lead, needsInput and delegates', () => {
    const worker = piConversationToSession('hearth', {
      id: 51,
      title: 'Parse config',
      kind: 'worker',
      lead: { conversationId: 50, host: 'local' },
      needsInput: true,
      delegates: false,
      owner: { conversationId: 50, taskId: 3 },
    });
    expect(worker.kind).toBe('worker');
    expect(worker.lead).toEqual({ instanceId: 'hearth', sessionId: '50' });
    expect(worker.needsInput).toBe(true);
    expect(worker.delegates).toBe(false);
    // `parentId` (task ownership) is kept alongside the crew fields.
    expect(worker.parentId).toBe('50');

    // A plain session carries no crew fields; the booleans read as false, not undefined.
    const plain = piConversationToSession('hearth', { id: 52 });
    expect(plain.kind).toBeUndefined();
    expect(plain.lead).toBeUndefined();
    expect(plain.needsInput).toBe(false);
    expect(plain.delegates).toBe(false);

    // A peer is addressable (visible) but keeps its `lead` as history.
    const peer = piConversationToSession('hearth', {
      id: 53,
      kind: 'peer',
      lead: { conversationId: 50, host: 'local' },
      delegates: true,
    });
    expect(peer.kind).toBe('peer');
    expect(peer.lead).toEqual({ instanceId: 'hearth', sessionId: '50' });
    expect(peer.delegates).toBe(true);
  });

  test('maps a promoted worker link: promotedTo stringified, absent otherwise', () => {
    const promoted = piConversationToSession('hearth', {
      id: 54,
      kind: 'worker',
      lead: { conversationId: 50, host: 'local' },
      promotedTo: 55,
    });
    expect(promoted.promotedTo).toBe('55');
    // A plain/peer session carries no link.
    expect(piConversationToSession('hearth', { id: 56 }).promotedTo).toBeUndefined();
    expect(piConversationToSession('hearth', { id: 57, kind: 'peer' }).promotedTo).toBeUndefined();
    // A promotedTo of 0 is a real id, not a falsy absence.
    expect(piConversationToSession('hearth', { id: 58, kind: 'worker', promotedTo: 0 }).promotedTo).toBe('0');
  });
});

describe('entries → messages', () => {
  test('maps user and assistant entries with reasoning, text and tool parts', () => {
    const entries: PiEntry[] = [
      { id: 1, kind: 'pi.user', model: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 10 }] },
      {
        id: 2,
        kind: 'pi.assistant',
        model: [
          assistant([
            { type: 'thinking', thinking: 'pondering' },
            { type: 'text', text: 'hi there' },
          ]),
        ],
      },
    ];
    const messages = piEntriesToMessages(entries);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].text).toBe('hello');
    expect(messages[1].parts.map((part) => part.type)).toEqual(['reasoning', 'text']);
    expect(messages[1].tokens).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1 });
    expect(messages[1].cost).toBe(0.002);
    expect(messages[1].model).toEqual({ providerID: 'opencode-go', modelID: 'glm-5.3-flash', variant: undefined });
  });

  test('the reasoning level the turn ran at rides on model.variant', () => {
    // pi-ai's AssistantMessage carries the Pi thinking level and the entry keeps the whole message, so a
    // finished turn can name the level it actually used — not the composer's current selection.
    const [mapped] = piEntriesToMessages([
      { id: 1, kind: 'pi.assistant', model: [assistant([{ type: 'text', text: 'hi' }], { thinkingLevel: 'high' })] },
    ]);
    expect(mapped.model).toEqual({ providerID: 'opencode-go', modelID: 'glm-5.3-flash', variant: 'high' });
  });

  test('providerThinkingLevel alone still names the level', () => {
    // The provider-native spelling is written by pi-ai's provider adapters, and on a pi-durable host it
    // is the only one of the two that gets written at all, so it has to work on its own.
    const [mapped] = piEntriesToMessages([
      { id: 1, kind: 'pi.assistant', model: [assistant([{ type: 'text', text: 'hi' }], { providerThinkingLevel: 'max' })] },
    ]);
    expect(mapped.model?.variant).toBe('max');
  });

  test('the Pi level wins when both fields are present', () => {
    const [mapped] = piEntriesToMessages([
      {
        id: 1,
        kind: 'pi.assistant',
        model: [assistant([{ type: 'text', text: 'hi' }], { thinkingLevel: 'low', providerThinkingLevel: 'effort-9' })],
      },
    ]);
    expect(mapped.model?.variant).toBe('low');
  });

  test('a turn with no level maps to variant undefined, never a guessed "default"', () => {
    // A legacy entry (written before the field existed) must render nothing rather than claim the
    // model's default level: "default" is not a level and would be a claim the data does not support.
    const [mapped] = piEntriesToMessages([
      { id: 1, kind: 'pi.assistant', model: [assistant([{ type: 'text', text: 'hi' }])] },
    ]);
    expect(mapped.model).toEqual({ providerID: 'opencode-go', modelID: 'glm-5.3-flash', variant: undefined });
    expect(mapped.model?.variant).not.toBe('default');
    // An empty string is "absent" too, not a level named "".
    const [blank] = piEntriesToMessages([
      { id: 2, kind: 'pi.assistant', model: [assistant([{ type: 'text', text: 'hi' }], { thinkingLevel: '  ', providerThinkingLevel: 'high' })] },
    ]);
    expect(blank.model?.variant).toBe('high');
  });

  test('Hearth user content is a plain string for text-only input', () => {
    // Real Hearth: UserMessage.content is `string | Block[]`; a typed message arrives as a string,
    // and treating it as an array used to throw and break the whole transcript load.
    const entries: PiEntry[] = [
      { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'test', timestamp: 10 }] },
      { id: 2, kind: 'pi.system', model: [{ role: 'system', content: [], timestamp: 11 }] },
      {
        id: 3,
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: [{ type: 'text', text: 'OK' }], stopReason: 'stop', timestamp: 12 }],
      },
    ];
    const messages = piEntriesToMessages(entries);
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'test'],
      ['assistant', 'OK'],
    ]);
  });

  test('a tool call merges its tool-result entry; an unfinished call stays completed', () => {
    const entries: PiEntry[] = [
      {
        id: 1,
        kind: 'pi.assistant',
        model: [assistant([{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo hi' } }], { stopReason: 'toolUse' })],
      },
      {
        id: 2,
        kind: 'pi.tool-result',
        model: [{ role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'hi\n' }], isError: false, timestamp: 20 }],
      },
      {
        id: 3,
        kind: 'pi.assistant',
        model: [assistant([{ type: 'text', text: 'done' }])],
      },
    ];
    const messages = piEntriesToMessages(entries);
    const toolPart = messages[0].parts.find((part) => part.type === 'tool') as { call: { status: string; title: string; output: string } };
    expect(toolPart.call.status).toBe('completed');
    expect(toolPart.call.title).toBe('echo hi');
    expect(toolPart.call.output).toBe('hi\n');
    expect(messages[1].text).toBe('done');
  });

  test('live tool slots mark running tools; an error result carries the message', () => {
    const entries: PiEntry[] = [
      {
        id: 1,
        kind: 'pi.assistant',
        model: [assistant([{ type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'sleep 1' } }], { stopReason: 'toolUse' })],
      },
      {
        id: 2,
        kind: 'pi.tool-result',
        model: [{ role: 'toolResult', toolCallId: 'c9', toolName: 'bash', content: [{ type: 'text', text: 'boom' }], isError: true, timestamp: 21 }],
      },
    ];
    const running = piEntriesToMessages(entries, { tools: [{ callId: 'c2', status: 'running', output: 'partial' }] });
    const part = running[0].parts.find((candidate) => candidate.type === 'tool') as { call: { status: string; output: string } };
    expect(part.call.status).toBe('running');
    expect(part.call.output).toBe('partial');
  });

  test('a step cut short by a stop is `interrupted`, not a red error', () => {
    const entries: PiEntry[] = [
      {
        id: 1,
        kind: 'pi.assistant',
        model: [assistant([{ type: 'toolCall', id: 'c3', name: 'bash', arguments: { command: 'sleep 100' } }], { stopReason: 'toolUse' })],
      },
      {
        id: 2,
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'c3',
            toolName: 'bash',
            content: [{ type: 'text', text: '<harness>\n[error] Tool bash was aborted\n</harness>' }],
            isError: true,
            timestamp: 22,
          },
        ],
      },
    ];
    const messages = piEntriesToMessages(entries);
    const part = messages[0].parts.find((candidate) => candidate.type === 'tool') as { call: { status: string } };
    expect(part.call.status).toBe('interrupted');
  });

  test('a genuine tool error is still a red error', () => {
    const entries: PiEntry[] = [
      {
        id: 1,
        kind: 'pi.assistant',
        model: [assistant([{ type: 'toolCall', id: 'c4', name: 'bash', arguments: { command: 'false' } }], { stopReason: 'toolUse' })],
      },
      {
        id: 2,
        kind: 'pi.tool-result',
        model: [{ role: 'toolResult', toolCallId: 'c4', toolName: 'bash', content: [{ type: 'text', text: 'Command exited with code 1' }], isError: true, timestamp: 23 }],
      },
    ];
    const messages = piEntriesToMessages(entries);
    const part = messages[0].parts.find((candidate) => candidate.type === 'tool') as { call: { status: string } };
    expect(part.call.status).toBe('error');
  });

  test('an error stop surfaces as a failed assistant turn; a user stop is aborted', () => {
    const failed = piEntriesToMessages([
      { id: 1, kind: 'pi.assistant', model: [assistant([], { stopReason: 'error' })] },
    ]);
    // The banner names the failure rather than saying only that one happened; a stop with no
    // provider message degrades to the honest fallback rather than the old generic wording.
    expect(failed[0].error).toContain('Failed');
    expect(failed[0].error).toContain('without reporting a reason');
    expect(failed[0].aborted).toBe(false);

    const aborted = piEntriesToMessages([
      { id: 2, kind: 'pi.assistant', model: [assistant([{ type: 'text', text: 'stopped' }], { stopReason: 'error', rawStopReason: 'aborted' })] },
    ]);
    expect(aborted[0].aborted).toBe(true);
    expect(aborted[0].error).toBeUndefined();

    // System and lifecycle entries never render.
    expect(
      piEntriesToMessages([
        { id: 3, kind: 'pi.system', model: [{ role: 'system', content: [{ type: 'text', text: 'prompt' }] }] },
        { id: 4, kind: 'pi.reset' },
      ])
    ).toHaveLength(0);
  });
});

describe('models, approvals, questions, inbox', () => {
  test('maps the pi catalogue with thinking-level variants and the default', () => {
    const mapped = piModelsToModelList(
      [
        {
          id: 'glm-5.3-flash',
          name: 'GLM-5.3 Flash',
          provider: 'opencode-go',
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0.15, output: 0.5 },
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          thinkingLevelMap: { low: 'low', high: 'high', medium: null },
        },
        { id: 'embed', provider: 'x', type: 'embedding' },
      ],
      { provider: 'opencode-go', modelId: 'glm-5.3-flash' }
    );
    expect(mapped.models).toHaveLength(1);
    // "off" leads (it sets no provider parameter, so the map omits it), and a null-mapped level
    // ("medium") is still not offered.
    expect(mapped.models[0].details.variants).toEqual(['off', 'low', 'high']);
    expect(mapped.models[0].details.attachment).toBe(true);
    expect(mapped.defaultModelId).toBe('opencode-go/glm-5.3-flash');
  });

  test('approvals and questions map onto Ember cards with routable ids', () => {
    const permission = piApprovalToPermissionRequest('hearth', {
      conversationId: '12',
      key: '77',
      tool: 'bash',
      arguments: { command: 'echo hi' },
    });
    expect(permission.id).toBe('12:77');
    expect(permission.sessionId).toBe('12');
    expect(permission.permission).toBe('bash');

    const question = piQuestionToQuestionRequest('hearth', {
      conversationId: '13',
      key: '78',
      question: 'Which licence?',
      options: ['MIT', 'CC-BY'],
    });
    expect(question.id).toBe('13:78');
    expect(question.questions[0].question).toBe('Which licence?');
    expect(question.questions[0].options.map((option) => option.label)).toEqual(['MIT', 'CC-BY']);
  });

  test('an attached image maps onto a file part, and an image-only turn survives', () => {
    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
    const entries: PiEntry[] = [
      {
        id: 1,
        kind: 'pi.user',
        model: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', data: PNG, mimeType: 'image/png' },
            ],
            timestamp: 10,
          },
        ],
      },
      // Image with no text at all: this turn used to be dropped from the transcript entirely.
      {
        id: 2,
        kind: 'pi.user',
        model: [{ role: 'user', content: [{ type: 'image', data: PNG, mimeType: 'image/jpeg' }], timestamp: 11 }],
      },
    ];
    const messages = piEntriesToMessages(entries);
    expect(messages).toHaveLength(2);
    expect(messages[0].parts.map((part) => part.type)).toEqual(['text', 'file']);
    const attached = messages[0].parts[1];
    expect(attached.type === 'file' && attached.file).toEqual({
      filename: 'image.png',
      mime: 'image/png',
      url: `data:image/png;base64,${PNG}`,
      contentDigest: expect.any(String),
    });
    expect(messages[1].text).toBe('');
    expect(messages[1].parts.map((part) => part.type)).toEqual(['file']);
    expect(messages[1].parts[0].type === 'file' && messages[1].parts[0].file.filename).toBe('image.jpg');
  });

  test('a tool result image keeps its screenshot name', () => {
    const entries: PiEntry[] = [
      {
        id: 1,
        kind: 'pi.assistant',
        model: [assistant([{ type: 'toolCall', id: 'call-1', name: 'view', arguments: {} }], { stopReason: 'toolUse' })],
      },
      {
        id: 2,
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            content: [{ type: 'image', data: 'AAAA', mimeType: 'image/webp' }],
            timestamp: 11,
          },
        ],
      },
    ];
    const part = piEntriesToMessages(entries)[0].parts[0];
    expect(part.type === 'tool' && part.call.images?.[0].filename).toBe('screenshot.webp');
  });

  test('inbox items map to queued messages with the conversation model as sendConfig', () => {
    const queued = piInboxToQueuedMessages(
      'hearth',
      12,
      [
        { id: 5, mode: 'followUp', content: 'also run the tests' },
        { id: 6, mode: 'write', entry: { kind: 'ember.note', data: { text: 'parked note' } } },
      ],
      { providerID: 'opencode-go', modelID: 'glm-5.3-flash', variant: 'high' }
    );
    expect(queued).toHaveLength(2);
    expect(queued[0].text).toBe('also run the tests');
    expect(queued[0].sendConfig).toEqual({ providerID: 'opencode-go', modelID: 'glm-5.3-flash', variant: 'high' });
    expect(queued[1].text).toBe('parked note');
  });

  test('a queued image keeps its payload so "send now" can still send it', () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
    const queued = piInboxToQueuedMessages(
      'hearth',
      12,
      [{ id: 7, mode: 'followUp', content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] }],
      { providerID: 'opencode-go', modelID: 'glm-5.3-flash' }
    );
    expect(queued[0].attachments).toEqual([
      { filename: 'image.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${PNG}` },
    ]);
  });
});

describe('the in-flight generation (pi.live)', () => {
  const thinking = (value: string) => ({ type: 'thinking', thinking: value, thinkingSignature: 'x' });
  const streamed = (content: Array<Record<string, unknown>>, timestamp = 2_000) => ({
    role: 'assistant',
    content,
    provider: 'opencode-go',
    model: 'glm-5.3-flash',
    timestamp,
  });

  test('a live slot with a thinking part streams as the transcript tail', () => {
    // Hearth keeps the running generation in `pi.live` and appends the durable entry only when it
    // ends, so this slot is where the reasoning the user is watching lives.
    const entries: PiEntry[] = [
      { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'why?', timestamp: 1_000 }] },
    ];
    const messages = piEntriesToMessages(entries, {
      run: { inputs: [1] },
      generation: { message: streamed([thinking('Weighing the options, step one')]) },
    });
    expect(messages).toHaveLength(2);
    const live = messages[1];
    expect(live.live).toBe(true);
    expect(live.id).toBe(LIVE_MESSAGE_ID);
    expect(live.completed).toBe(false);
    expect(live.parts).toEqual([
      { type: 'reasoning', id: `${LIVE_MESSAGE_ID}-0`, text: 'Weighing the options, step one' },
    ]);
  });

  test('the final entry carries the thinking, so the block survives the slot clearing', () => {
    // The fixture: a live slot with reasoning, then the durable entry that replaces it. The real
    // Hearth terminal message carries the thinking blocks, so the reasoning the user watched is
    // in the settled message too.
    const entries: PiEntry[] = [
      { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'why?', timestamp: 1_000 }] },
      {
        id: 2,
        kind: 'pi.assistant',
        model: [assistant([thinking('Weighing the options'), { type: 'text', text: 'Because.' }], { timestamp: 2_000 })],
      },
    ];
    const streaming = piEntriesToMessages(entries.slice(0, 1), {
      generation: { message: streamed([thinking('Weighing the options')]) },
    });
    expect(streaming.some((message) => message.live)).toBe(true);
    // The slot is gone in the same commit that appends the entry, so the transcript never shows
    // nothing for the turn: the settled message arrives with its reasoning part.
    const settled = piEntriesToMessages(entries);
    expect(settled.some((message) => message.live)).toBe(false);
    const reasoning = settled
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'reasoning')
      .map((part) => (part as { text: string }).text);
    expect(reasoning).toEqual(['Weighing the options']);
  });

  test('the streaming slot names the level exactly as its settled entry will', () => {
    // The two mapping paths have to agree: if the live slot dropped the level, a turn would show no
    // level while streaming and then grow one when it settled.
    const entry: PiEntry = {
      id: 2,
      kind: 'pi.assistant',
      model: [assistant([{ type: 'text', text: 'Because.' }], { timestamp: 2_000, thinkingLevel: 'low' })],
    };
    const live = piEntriesToMessages(
      [{ id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'why?', timestamp: 1_000 }] }],
      { generation: { message: { ...streamed([{ type: 'text', text: 'Because.' }]), thinkingLevel: 'low' } } }
    );
    expect(live.some((message) => message.live)).toBe(true);
    expect(live[live.length - 1].model).toEqual({
      providerID: 'opencode-go',
      modelID: 'glm-5.3-flash',
      variant: 'low',
    });
    // The entry that replaces the slot reports the same level.
    const settled = piEntriesToMessages([{ id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'why?', timestamp: 1_000 }] }, entry]);
    expect(settled[settled.length - 1].model?.variant).toBe('low');
  });

  test('an empty live slot adds nothing', () => {
    const entries: PiEntry[] = [{ id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'hi', timestamp: 1 }] }];
    expect(piEntriesToMessages(entries, { generation: { message: streamed([]) } })).toHaveLength(1);
    expect(piEntriesToMessages(entries, { generation: { retry: { error: 'rate limited' } } })).toHaveLength(1);
  });

  test('a settled entry with the same text means the slot is already reflected', () => {
    const entries: PiEntry[] = [
      {
        id: 2,
        kind: 'pi.assistant',
        model: [assistant([{ type: 'text', text: 'Because.' }], { timestamp: 2_000 })],
      },
    ];
    const messages = piEntriesToMessages(entries, {
      generation: { message: streamed([{ type: 'text', text: 'Because.' }]) },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].live).toBeUndefined();
  });

  test('a step that only reasoned is a message, not a dropped one', () => {
    // 53 such entries exist in this Hearth's database (`["thinking"]`, usually an aborted step).
    const entries: PiEntry[] = [
      {
        id: 9,
        kind: 'pi.assistant',
        model: [assistant([thinking('Half a thought')], { stopReason: 'aborted', timestamp: 5_000 })],
      },
    ];
    const messages = piEntriesToMessages(entries);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toEqual([{ type: 'reasoning', id: 'e9-0', text: 'Half a thought' }]);
  });
});

describe('a failed turn names the provider error', () => {
  // Real errorMessage values read out of a live Moonshot conversation. All three are 429s and all
  // three need different responses, which the old generic banner could not express.
  const raw = (errorMessage: string) => [
    {
      id: 1,
      kind: 'pi.assistant' as const,
      model: [assistant([], { stopReason: 'error', errorMessage })],
    },
  ];

  test('429 engine overloaded reads as overloaded', () => {
    const [message] = piEntriesToMessages(
      raw(
        '429: {"message":"The engine is currently overloaded, please try again later","type":"engine_overloaded_error"}'
      )
    );
    expect(message.error).toContain('Provider overloaded (429)');
    expect(message.error).toContain('try again');
  });

  test('429 quota exhaustion does not tell the user to retry', () => {
    const [message] = piEntriesToMessages(
      raw(
        '429: {"message":"Your credit balance is running low for account <org-0fc75c91>, please recharge","type":"exceeded_current_quota_error"}'
      )
    );
    expect(message.error).toContain('Out of credit (429)');
    expect(message.error).toContain('Add credit');
    expect(message.error).not.toContain('Try again in a moment');
  });

  test('the account id in a rate-limit message is redacted before it is displayed', () => {
    const [message] = piEntriesToMessages(
      raw(
        '429: {"message":"Your account org-0fc75c915eb946f48b877ea3f062e3e9 reached TPM rate limit","type":"rate_limit_reached_error"}'
      )
    );
    expect(message.error).toContain('Rate limited (429)');
    expect(message.error).not.toContain('0fc75c915eb946f48b877ea3f062e3e9');
  });
});

describe('turn timing', () => {
  const entry = (extra: Record<string, unknown>) => [
    { id: 1, kind: 'pi.assistant' as const, model: [assistant([{ type: 'text', text: 'hi' }], extra)] },
  ];

  test('durationMs turns the request-start timestamp into a real completion time', () => {
    const [message] = piEntriesToMessages(entry({ timestamp: 1_000, durationMs: 2_500 }));
    expect(message.createdAt).toBe(1_000);
    expect(message.completedAt).toBe(3_500);
  });

  test('the mapped span is what the footer needs for tok/s and a duration', () => {
    const [message] = piEntriesToMessages(entry({ timestamp: 1_000, durationMs: 2_500 }));
    const seconds = (message.completedAt! - message.createdAt!) / 1000;
    expect(seconds).toBeGreaterThan(0);
    // 20 output tokens over 2.5s.
    expect((message.tokens?.output ?? 0) / seconds).toBe(8);
  });

  test('an entry written before pi-ai stamped a duration reports no completion at all', () => {
    // The regression risk: faking `timestamp` as `completedAt` makes a zero-length turn, which
    // renders "0ms" and a meaningless tok/s. Absent timing must stay absent.
    const [message] = piEntriesToMessages(entry({ timestamp: 1_000 }));
    expect(message.createdAt).toBe(1_000);
    expect(message.completedAt).toBeUndefined();
  });

  test('a zero-length duration is honoured as a real zero, not mistaken for missing', () => {
    const [message] = piEntriesToMessages(entry({ timestamp: 1_000, durationMs: 0 }));
    // completedAt is set and equal, so the footer's `completedAt > createdAt` guard suppresses it
    // rather than the mapper inventing one.
    expect(message.completedAt).toBe(1_000);
  });

  test('a toolUse step continues the turn, so it never carries a completion time', () => {
    const [message] = piEntriesToMessages(
      entry({ stopReason: 'toolUse', timestamp: 1_000, durationMs: 800 })
    );
    expect(message.completedAt).toBeUndefined();
    expect(message.completed).toBe(false);
  });

  test('a failed turn still carries its completion time', () => {
    const [message] = piEntriesToMessages(
      entry({ stopReason: 'error', errorMessage: '429: overloaded', timestamp: 1_000, durationMs: 400 })
    );
    expect(message.completedAt).toBe(1_400);
  });

  test('a duration with no start timestamp yields no completion rather than NaN', () => {
    const [message] = piEntriesToMessages(entry({ timestamp: undefined, durationMs: 900 }));
    expect(message.completedAt).toBeUndefined();
  });
});

describe('the newest entry id a transcript holds', () => {
  const message = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    role: 'assistant',
    text: '',
    parts: [],
    completed: true,
    ...extra,
  });

  test('skips the live generation and optimistic sends, and finds nothing in a legacy transcript', () => {
    expect(newestEntryId([])).toBeUndefined();
    expect(newestEntryId([message('e1'), message('e2'), message('pi-live', { live: true })])).toBe(2);
    expect(newestEntryId([message('e9'), message('client-1')])).toBe(9);
    expect(newestEntryId([message('msg_legacy')])).toBeUndefined();
  });
});

/**
 * `codemode` runs a script that makes its own tool calls. The host reports them twice: live, in
 * `pi.live.nestedTools`, while the script runs, and once as `details.calls` on the settled result.
 * Both halves have to reach the same `nestedCalls` list on the call, or the row would lose the
 * script's steps the moment it finished.
 */
describe('a codemode script’s nested calls', () => {
  const scriptCall = (id = 'call-1'): PiEntry => ({
    id: 1,
    kind: 'pi.assistant',
    model: [
      assistant(
        [{ type: 'toolCall', id, name: 'codemode', arguments: { code: 'await tools.read({ path: "a.ts" })' } }],
        { stopReason: 'toolUse' }
      ),
    ],
  });

  const callOf = (messages: readonly ChatMessage[]) => {
    const part = messages.flatMap((message) => message.parts).find((candidate) => candidate.type === 'tool');
    if (!part || part.type !== 'tool') throw new Error('no tool part');
    return part.call;
  };

  test('live nested slots attach while the script runs', () => {
    // pi-durable 1.4.0's shape: a list of slots, `callId` `<parent>/<key>`, outcome in `summary`.
    const live = {
      run: { inputs: [1] },
      tools: [{ callId: 'call-1', status: 'running' as const }],
      nestedTools: [
        {
          callId: 'call-1/c1',
          parentCallId: 'call-1',
          parentTaskId: 3,
          taskId: 4,
          name: 'read',
          arguments: { path: 'a.ts' },
          status: 'done' as const,
          summary: { isError: false, durationMs: 12 },
        },
        {
          callId: 'call-1/c2',
          parentCallId: 'call-1',
          parentTaskId: 3,
          taskId: 5,
          name: 'bash',
          arguments: { command: 'ls' },
          status: 'running' as const,
        },
      ],
    };
    const call = callOf(piEntriesToMessages([scriptCall()], live));
    expect(call.status).toBe('running');
    expect(call.nestedCalls).toEqual([
      { id: 'c1', name: 'read', args: '{"path":"a.ts"}', status: 'ok', durationMs: 12 },
      { id: 'c2', name: 'bash', args: '{"command":"ls"}', status: 'running' },
    ]);
  });

  test('a failed live slot reads as an error, with its message', () => {
    const live = {
      tools: [{ callId: 'call-1', status: 'running' as const }],
      nestedTools: [
        {
          callId: 'call-1/c1',
          parentCallId: 'call-1',
          name: 'read',
          arguments: { path: 'missing.ts' },
          status: 'done' as const,
          summary: { isError: true, error: 'ENOENT' },
        },
      ],
    };
    const [nested] = callOf(piEntriesToMessages([scriptCall()], live)).nestedCalls ?? [];
    expect(nested.status).toBe('error');
    expect(nested.error).toBe('ENOENT');
  });

  test('a keyed nestedTools map works too, keyed by parent call id', () => {
    // Some payloads send `{ [parentCallId]: { [key]: slot } }` rather than a list.
    const live = {
      nestedTools: {
        'call-1': {
          c1: { name: 'read', args: '{"path":"a.ts"}', status: 'running' as const },
        },
      },
    };
    const call = callOf(piEntriesToMessages([scriptCall()], live));
    expect(call.nestedCalls).toEqual([
      { id: 'c1', name: 'read', args: '{"path":"a.ts"}', status: 'running' },
    ]);
  });

  test('another call’s nested slots are not attached', () => {
    const live = {
      nestedTools: [
        { callId: 'other/c1', parentCallId: 'other', name: 'read', status: 'running' as const },
      ],
    };
    expect(callOf(piEntriesToMessages([scriptCall()], live)).nestedCalls).toBeUndefined();
  });

  test('with no nested slots at all the field stays absent', () => {
    const call = callOf(piEntriesToMessages([scriptCall()], { tools: [{ callId: 'call-1', status: 'running' }] }));
    expect(call.nestedCalls).toBeUndefined();
  });

  test('a settled result replaces the nested calls and adds the full output path', () => {
    const entries: PiEntry[] = [
      scriptCall(),
      {
        id: 2,
        kind: 'pi.tool-result',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            isError: false,
            timestamp: 1_100,
            content: [{ type: 'text', text: 'script finished' }],
            details: {
              calls: [
                { id: 1, name: 'read', args: '{"path":"a.ts"}', status: 'ok', durationMs: 12 },
                { id: 2, name: 'bash', args: '{"command":"ls"}', status: 'error', error: 'exit 1' },
              ],
              fullOutputPath: '/tmp/codemode/out.txt',
            },
          },
        ],
      },
    ];
    const call = callOf(piEntriesToMessages(entries));
    expect(call.status).toBe('completed');
    expect(call.nestedCalls).toEqual([
      { id: '1', name: 'read', args: '{"path":"a.ts"}', status: 'ok', durationMs: 12 },
      { id: '2', name: 'bash', args: '{"command":"ls"}', status: 'error', error: 'exit 1' },
    ]);
    expect(call.fullOutputPath).toBe('/tmp/codemode/out.txt');
  });

  test('a host that nests details under entry.data is read the same way', () => {
    const entries: PiEntry[] = [
      scriptCall(),
      {
        id: 2,
        kind: 'pi.tool-result',
        data: { details: { calls: [{ id: 1, name: 'view', args: '{}', status: 'ok' }], fullOutputPath: '/tmp/out' } },
        model: [{ role: 'toolResult', toolCallId: 'call-1', isError: false, timestamp: 1_100, content: [] }],
      },
    ];
    const call = callOf(piEntriesToMessages(entries));
    expect(call.nestedCalls).toEqual([{ id: '1', name: 'view', args: '{}', status: 'ok' }]);
    expect(call.fullOutputPath).toBe('/tmp/out');
  });

  test('extractNestedCalls prefers the settled list, and reads both argument spellings', () => {
    expect(
      extractNestedCalls(
        { calls: [{ id: 7, name: 'read', args: '{"path":"a.ts"}', status: 'cancelled' }] },
        [{ callId: 'p/c1', name: 'bash', status: 'running' }]
      )
    ).toEqual([{ id: '7', name: 'read', args: '{"path":"a.ts"}', status: 'cancelled' }]);

    // A live slot names its arguments `arguments`; a nested call with no name still reads as one.
    expect(extractNestedCalls(undefined, [{ name: 'read', arguments: { path: 'a.ts' }, status: 'pending' }])).toEqual([
      { id: '0', name: 'read', args: '{"path":"a.ts"}', status: 'running' },
    ]);
    // Nothing to report: absent rather than an empty list on every tool call.
    expect(extractNestedCalls(undefined, undefined)).toBeUndefined();
    expect(extractNestedCalls({ fullOutputPath: '/tmp/x' }, undefined)).toBeUndefined();
  });
});

describe('entryOrdinal', () => {
  test('reads the host ordinal out of a Hearth message id', () => {
    expect(entryOrdinal('e41')).toBe(41);
    expect(entryOrdinal('e0007')).toBe(7);
  });

  test('an id without an ordinal says so, rather than inventing one', () => {
    // OpenChamber mints ids like `msg_abc`; the caller falls back to timestamps for those.
    expect(entryOrdinal('msg_abc')).toBeNull();
    expect(entryOrdinal('e0')).toBeNull();
    expect(entryOrdinal('')).toBeNull();
    expect(entryOrdinal('e12x')).toBeNull();
    // Live streams carry a sentinel id, not an entry.
    expect(entryOrdinal(LIVE_MESSAGE_ID)).toBeNull();
  });
});

test('internal thread completion and continuation entries are not human messages or read targets', () => {
  const messages = piEntriesToMessages([
    { id: 1, kind: 'hearth.thread-result', data: {} },
    { id: 2, kind: 'hearth.thread-notice', model: [{ role: 'user', content: '[threads] Outcomes available', timestamp: 1000 }] },
  ]);
  expect(messages).toEqual([]);
});
