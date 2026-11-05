import { describe, expect, test } from 'bun:test';
import { followUpsFor } from './src/lib/followUps';
import type { ChatMessage } from './src/types';

const tool = (name: string, status: 'completed' | 'error' = 'completed', input?: Record<string, unknown>) =>
  ({ type: 'tool' as const, id: `t-${name}`, call: { id: `c-${name}`, tool: name, status, input } });
const assistant = (parts: ChatMessage['parts'], extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'a',
  role: 'assistant',
  text: '',
  parts,
  completed: true,
  ...extra,
});
const idle = { busy: false, hasCrew: false };
const labels = (messages: ChatMessage[], context = idle) =>
  followUpsFor(messages, context).map((chip) => chip.label);

describe('followUpsFor', () => {
  test('an edit offers the diff', () => {
    expect(labels([assistant([tool('edit')])])).toContain('Show the diff');
  });

  test('a failed command offers a retry carrying the command', () => {
    const chips = followUpsFor([assistant([tool('bash', 'error', { command: 'bun test' })])], idle);
    const retry = chips.find((chip) => chip.label === 'Retry that command');
    expect(retry?.text).toContain('bun test');
  });

  test('a test command that passed offers to run it again', () => {
    expect(labels([assistant([tool('bash', 'completed', { command: 'bun run test' })])])).toContain(
      'Run the tests again'
    );
  });

  test('a failed turn leads with the explanation', () => {
    const chips = followUpsFor([assistant([], { error: 'boom' })], idle);
    expect(chips.map((chip) => chip.label)).toContain('Explain the failure');
  });

  test('a crew session offers a summary for the crew', () => {
    expect(labels([assistant([tool('read')])], { busy: false, hasCrew: true })).toContain(
      'Summarise for the crew'
    );
  });

  test('a tool call and its result in separate messages still offer chips', () => {
    expect(labels([assistant([tool('write')]), assistant([tool('bash', 'completed', { command: 'ls' })])])).toContain(
      'Show the diff'
    );
  });

  test('a busy session offers nothing', () => {
    expect(followUpsFor([assistant([tool('edit')])], { busy: true, hasCrew: false })).toEqual([]);
  });
});

describe('standing chips and the assistant own offer', () => {
  test('Status? and Ok, continue lead every row', () => {
    const chips = followUpsFor([assistant([], { text: 'Done.' })], idle);
    expect(chips.slice(0, 2).map((chip) => chip.label)).toEqual(['Status?', 'Ok, continue']);
    expect(chips[1].text).toBe('Ok, continue');
  });

  test('an explicit offer becomes a chip carrying its own words', () => {
    const chips = followUpsFor(
      [assistant([], { text: 'The migration is written.\n\nNext, run the seed script against staging.' })],
      idle
    );
    expect(chips.find((chip) => chip.id === 'offer')?.text).toBe('run the seed script against staging');
  });

  test('"Would you like me to" is an offer, without the question mark', () => {
    const chips = followUpsFor(
      [assistant([], { text: 'Done. Would you like me to add a regression test?' })],
      idle
    );
    expect(chips.find((chip) => chip.id === 'offer')?.text).toBe('add a regression test');
  });

  test('a sentence that merely ends the turn is not an offer', () => {
    const chips = followUpsFor([assistant([], { text: 'The build passes and the tests are green.' })], idle);
    expect(chips.some((chip) => chip.id === 'offer')).toBe(false);
  });

  test('the row never exceeds the cap', () => {
    const chips = followUpsFor(
      [assistant([tool('edit'), tool('bash', 'error', { command: 'bun test' })], { text: 'Next, fix the type error.' })],
      { busy: false, hasCrew: true }
    );
    expect(chips.length).toBeLessThanOrEqual(4);
  });
});
