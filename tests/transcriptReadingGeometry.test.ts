import { describe, expect, test } from 'bun:test';
import { isHumanReadingMessage, isProseAssistantMessage, previousTarget } from '../src/lib/transcriptReadingGeometry';

const viewport = { top: 100, bottom: 500 };
const row = (index: number, top: number, bottom: number) => ({ index, top, bottom });

describe('previous bot message', () => {
  test('a reply clipped at the top targets its own start', () => {
    // Index order and geometry order agree: each row sits below the one with a smaller index.
    expect(previousTarget(viewport, [row(0, -300, -200), row(1, -150, 90), row(2, 0, 60)])).toEqual({ index: 2, align: 'start' });
  });

  test('a fully visible reply targets the one above it', () => {
    expect(previousTarget(viewport, [row(0, -300, -100), row(1, 120, 260), row(2, 300, 480)])).toEqual({ index: 0, align: 'start' });
  });

  test('a reply that only just starts below the viewport top is not clipped', () => {
    expect(previousTarget(viewport, [row(0, -300, -100), row(1, 120, 260)])).toEqual({ index: 0, align: 'start' });
    // Exactly on the edge is fully visible too.
    expect(previousTarget(viewport, [row(0, -300, -100), row(1, 100, 260)])).toEqual({ index: 0, align: 'start' });
  });

  test('nothing visible falls back to the last one above the viewport', () => {
    expect(previousTarget(viewport, [row(0, -300, -200), row(1, -150, -110), row(2, 600, 700)])).toEqual({ index: 1, align: 'start' });
  });

  test('nothing above the viewport has no target', () => {
    expect(previousTarget(viewport, [])).toBeNull();
    expect(previousTarget(viewport, [row(0, 600, 700), row(1, 800, 900)])).toBeNull();
  });
});

describe('previous sent message', () => {
  test('a sent message clipped at the top targets its own start', () => {
    expect(previousTarget(viewport, [row(0, -100, 400), row(1, -50, 60)])).toEqual({ index: 0, align: 'start' });
  });

  test('a fully visible sent message targets the one above it', () => {
    expect(previousTarget(viewport, [row(0, -300, -100), row(1, 150, 250)])).toEqual({ index: 0, align: 'start' });
  });

  test('nothing visible falls back to the last one above the viewport', () => {
    expect(previousTarget(viewport, [row(0, -300, -120), row(1, 600, 700)])).toEqual({ index: 0, align: 'start' });
  });

  test('nothing above the viewport has no target', () => {
    expect(previousTarget(viewport, [])).toBeNull();
    expect(previousTarget(viewport, [row(0, 500, 600)])).toBeNull();
  });
});

describe('reading geometry guards', () => {
  test('a collapsed viewport offers nothing', () => {
    expect(previousTarget({ top: 350, bottom: 350 }, [row(0, 0, 100)])).toBeNull();
  });

  test('rows are ordered by message index, not by the order they were collected in', () => {
    expect(previousTarget(viewport, [row(1, -300, -100), row(0, 150, 250), row(2, 300, 450)])).toEqual({ index: 1, align: 'start' });
  });
});

test('crew report cards are not a new human message', () => {
  expect(isHumanReadingMessage({ role: 'user', text: 'Please check this.' })).toBe(true);
  expect(isHumanReadingMessage({ role: 'user', text: '[crew] Parse config finished' })).toBe(false);
  expect(isHumanReadingMessage({ role: 'assistant', text: 'Done' })).toBe(false);
});

test('a bot turn with only tool calls is not a destination', () => {
  expect(isProseAssistantMessage({ role: 'assistant', text: 'Here is what I found.' })).toBe(true);
  expect(isProseAssistantMessage({ role: 'assistant', text: '   ' })).toBe(false);
  expect(isProseAssistantMessage({ role: 'assistant', text: '' })).toBe(false);
  expect(isProseAssistantMessage({ role: 'user', text: 'Do it again.' })).toBe(false);
});
