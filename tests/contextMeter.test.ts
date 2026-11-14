import { describe, expect, test } from 'bun:test';
import { contextMeterLabel, contextMeterState, contextMeterTooltip, tokensInContext } from '../src/lib/contextMeter';
import type { ChatMessage, ModelRef } from '../src/types';

const TURN_MODEL: ModelRef = { providerID: 'hearth', modelID: 'big-window' };
const OTHER_MODEL: ModelRef = { providerID: 'hearth', modelID: 'small-window' };

const usage = (input: number, output = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

const assistant = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `a-${Math.random().toString(36).slice(2)}`,
  role: 'assistant',
  text: 'done',
  parts: [],
  model: TURN_MODEL,
  tokens: usage(50_000, 500),
  completed: true,
  ...overrides,
});

const user = (text = 'hello'): ChatMessage => ({
  id: `u-${Math.random().toString(36).slice(2)}`,
  role: 'user',
  text,
  parts: [],
  completed: true,
});

/** A catalogue entry shaped like the picker's; the window is what the meter measures against. */
const model = (ref: ModelRef, contextTokens?: number) => ({
  providerID: ref.providerID,
  modelID: ref.modelID,
  details: contextTokens === undefined ? {} : { contextTokens },
});

describe('tokensInContext', () => {
  test('counts the prompt (fresh and cached) plus what the turn wrote back', () => {
    expect(tokensInContext({ input: 10, output: 3, cacheRead: 100, cacheWrite: 7 })).toBe(120);
  });
});

describe('contextMeterState', () => {
  test('a session with no completed turn reports nothing at all', () => {
    expect(contextMeterState([], model(TURN_MODEL, 200_000))).toEqual({ kind: 'none' });
    // A live turn has no usage yet; the previous turn's count is what is in the window.
    const live = assistant({ live: true, tokens: undefined, completed: false });
    expect(contextMeterState([user(), live], model(TURN_MODEL, 200_000))).toEqual({ kind: 'none' });
  });

  test('the same model on both sides gives a percentage', () => {
    const state = contextMeterState([user(), assistant()], model(TURN_MODEL, 200_000));
    expect(state).toEqual({ kind: 'known', used: 50_500, limit: 200_000, percent: 25, model: TURN_MODEL });
  });

  test('the previous turn still measures while the next one streams', () => {
    const messages = [user(), assistant(), user('more'), assistant({ live: true, tokens: undefined, completed: false })];
    expect(contextMeterState(messages, model(TURN_MODEL, 200_000))).toMatchObject({ kind: 'known', percent: 25 });
  });

  test('switching to a smaller-window model makes the ratio unknown, not larger', () => {
    // The turn ran on the big model; the composer now points at a small one. 50.5k / 100k would be
    // 51% — a number about nothing, and the old code would have compacted on it.
    const state = contextMeterState([user(), assistant()], model(OTHER_MODEL, 100_000));
    expect(state).toEqual({
      kind: 'unknown',
      reason: 'model-changed',
      used: 50_500,
      turnModel: TURN_MODEL,
      selectedModel: OTHER_MODEL,
    });
    expect(contextMeterTooltip(state)).toContain('big-window');
    expect(contextMeterTooltip(state)).toContain('small-window');
  });

  test('no usage from the provider is unknown, not 0%', () => {
    const state = contextMeterState([user(), assistant({ tokens: undefined })], model(TURN_MODEL, 200_000));
    expect(state).toEqual({ kind: 'unknown', reason: 'no-usage', turnModel: TURN_MODEL, selectedModel: TURN_MODEL });
    // An all-zero usage report is the same story as no usage report.
    expect(contextMeterState([user(), assistant({ tokens: usage(0) })], model(TURN_MODEL, 200_000))).toMatchObject({
      kind: 'unknown',
      reason: 'no-usage',
    });
  });

  test('no context window is unknown, not 0%', () => {
    const noWindow = contextMeterState([user(), assistant()], model(TURN_MODEL));
    expect(noWindow).toMatchObject({ kind: 'unknown', reason: 'no-window', used: 50_500 });
    const zeroWindow = contextMeterState([user(), assistant()], model(TURN_MODEL, 0));
    expect(zeroWindow).toMatchObject({ kind: 'unknown', reason: 'no-window' });
    // …and so is having nothing selected to read a window from.
    expect(contextMeterState([user(), assistant()], undefined)).toMatchObject({ kind: 'unknown', reason: 'model-changed' });
  });

  test('a turn that recorded no model cannot be measured', () => {
    const state = contextMeterState([user(), assistant({ model: undefined })], model(TURN_MODEL, 200_000));
    expect(state).toEqual({ kind: 'unknown', reason: 'no-turn-model', used: 50_500, selectedModel: TURN_MODEL });
  });

  test('only the last completed assistant turn counts', () => {
    const messages = [user(), assistant(), user('again'), assistant({ tokens: usage(190_000), id: 'latest' })];
    expect(contextMeterState(messages, model(TURN_MODEL, 200_000))).toMatchObject({ kind: 'known', used: 190_000, percent: 95 });
  });
});

describe('context meter copy', () => {
  test('the known label states the percentage and the click', () => {
    const state = contextMeterState([user(), assistant()], model(TURN_MODEL, 200_000));
    expect(contextMeterLabel(state)).toContain('25%');
    expect(contextMeterLabel(state)).toContain('compact');
    expect(contextMeterTooltip(state)).toContain('51k');
    expect(contextMeterTooltip(state)).toContain('200k');
  });

  test('the unknown label says "unknown" and still offers the manual compaction', () => {
    const state = contextMeterState([user(), assistant({ tokens: undefined })], model(TURN_MODEL, 200_000));
    const label = contextMeterLabel(state);
    expect(label.toLowerCase()).toContain('unknown');
    expect(label.toLowerCase()).toContain('compact');
    // No invented number, and no jargon.
    expect(label).not.toContain('0%');
    expect(label).not.toContain('null');
    expect(label).not.toContain('undefined');
    expect(contextMeterTooltip(state).toLowerCase()).not.toContain('null');
  });

  test('every unknown reason names the fact that is missing', () => {
    const reasons = [
      contextMeterState([user(), assistant({ tokens: undefined })], model(TURN_MODEL, 200_000)),
      contextMeterState([user(), assistant({ model: undefined })], model(TURN_MODEL, 200_000)),
      contextMeterState([user(), assistant()], model(OTHER_MODEL, 100_000)),
      contextMeterState([user(), assistant()], model(TURN_MODEL)),
    ];
    for (const state of reasons) {
      const text = contextMeterTooltip(state).toLowerCase();
      expect(text).toContain('unknown');
      expect(text.length).toBeGreaterThan(40);
    }
  });
});
