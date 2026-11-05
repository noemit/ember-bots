import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ContextMeter from './src/components/ContextMeter';
import { TooltipProvider } from './src/components/ui/tooltip';
import { contextMeterState } from './src/lib/contextMeter';
import type { ChatMessage, ModelRef } from './src/types';

const TURN_MODEL: ModelRef = { providerID: 'hearth', modelID: 'big-window' };
const OTHER_MODEL: ModelRef = { providerID: 'hearth', modelID: 'small-window' };

const messages: ChatMessage[] = [
  { id: 'u', role: 'user', text: 'hi', parts: [], completed: true },
  {
    id: 'a',
    role: 'assistant',
    text: 'done',
    parts: [],
    model: TURN_MODEL,
    tokens: { input: 170_000, output: 500, cacheRead: 0, cacheWrite: 0 },
    completed: true,
  },
];

const window_ = (ref: ModelRef, contextTokens?: number) => ({
  providerID: ref.providerID,
  modelID: ref.modelID,
  details: contextTokens === undefined ? {} : { contextTokens },
});

const markup = (state: ReturnType<typeof contextMeterState>) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <ContextMeter state={state} compacting={false} onCompact={() => {}} />
    </TooltipProvider>
  );

/**
 * The visual half of the meter's honesty rule: a known ratio draws an arc and states its
 * percentage, and an unknown one draws a bare ring and never shows a number — above all never the
 * `0%` that a missing numerator or denominator used to render as.
 */
describe('ContextMeter rendering', () => {
  test('a known ratio draws an arc and states the percentage', () => {
    const html = markup(contextMeterState(messages, window_(TURN_MODEL, 200_000)));
    expect(html).toContain('data-context-meter="known"');
    expect(html).toContain('stroke-dasharray');
    expect(html).toContain('Context 85% used');
  });

  test('an unknown ratio states "unknown" and shows no arc', () => {
    const html = markup(contextMeterState(messages, window_(OTHER_MODEL, 8_000)));
    expect(html).toContain('data-context-meter="unknown"');
    expect(html).not.toContain('stroke-dasharray');
    expect(html).toContain('Context unknown');
    // The whole point: no invented number, and specifically not the old "0%".
    expect(html).not.toContain('%');
  });

  test('the button stays clickable while unknown, so manual compaction is never lost', () => {
    const html = markup(contextMeterState(messages, window_(OTHER_MODEL, 8_000)));
    // An enabled <button> (the only `disabled` in the markup is the hover style's variant class).
    expect(html).not.toMatch(/<button[^>]*\sdisabled[\s=>]/);
    expect(html).toContain('data-context-meter="unknown"');
    expect(html).toContain('Click to compact');
  });

  test('the button disables manual compaction while a turn is running', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ContextMeter
          state={contextMeterState(messages, window_(TURN_MODEL, 200_000))}
          compacting={false}
          turnBusy
          onCompact={() => {}}
        />
      </TooltipProvider>
    );
    expect(html).toMatch(/<button[^>]*\sdisabled[\s=>]/);
  });
});
