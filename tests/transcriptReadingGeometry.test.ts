import { describe, expect, test } from 'bun:test';
import { shouldOfferLastMessageJump as jump } from '../src/lib/transcriptReadingGeometry';

const viewport = { top: 100, bottom: 500 };
describe('last user message navigation geometry', () => {
  test('offers only after the entire latest user message leaves above', () => {
    expect(jump(viewport, { top: 10, bottom: 100 }, [])).toBe(true);
    expect(jump(viewport, { top: 10, bottom: 101 }, [])).toBe(false);
    expect(jump(viewport, { top: 500, bottom: 600 }, [])).toBe(false);
    expect(jump(viewport, undefined, [])).toBe(false);
  });
  test('any partially visible user suppresses it, including a tall row surrounding viewport', () => {
    const latest = { top: -100, bottom: 0 };
    for (const row of [{ top: 99, bottom: 101 }, { top: 499, bottom: 600 }, { top: 0, bottom: 700 }]) {
      expect(jump(viewport, latest, [row])).toBe(false);
    }
    expect(jump(viewport, latest, [{ top: -20, bottom: 100 }, { top: 500, bottom: 600 }])).toBe(true);
  });
  test('works with offset column/modal coordinates and missing virtualized user DOM', () => {
    expect(jump({ top: 350, bottom: 800 }, { top: 200, bottom: 349 }, [])).toBe(true);
    expect(jump({ top: 350, bottom: 350 }, { top: 200, bottom: 349 }, [])).toBe(false);
  });
});

test('crew report cards are not a new human message', async () => {
  const { isHumanReadingMessage } = await import('../src/lib/transcriptReadingGeometry');
  expect(isHumanReadingMessage({ role: 'user', text: 'Please check this.' })).toBe(true);
  expect(isHumanReadingMessage({ role: 'user', text: '[crew] Parse config finished' })).toBe(false);
  expect(isHumanReadingMessage({ role: 'assistant', text: 'Done' })).toBe(false);
});
