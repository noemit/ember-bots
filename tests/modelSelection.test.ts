import { describe, expect, test } from 'bun:test';
import { canonicalVariant, REASONING_OFF, resolveComposerModel, sameVariant } from '../src/lib/modelSelection';

describe('reasoning levels', () => {
  test('an advertised level resolves to the catalogue spelling', () => {
    expect(canonicalVariant(['low', 'high'], 'High')).toBe('high');
  });

  test('"off" resolves without being advertised', () => {
    // Hearth's thinkingLevelMap only lists levels that send a provider parameter; "off" sends none,
    // yet conversations — workers especially — carry it. Blocking the composer on it was a bug.
    expect(canonicalVariant(['low', 'high'], REASONING_OFF)).toBe(REASONING_OFF);
    expect(canonicalVariant(['low', 'high'], 'Off')).toBe(REASONING_OFF);
    expect(canonicalVariant(undefined, REASONING_OFF)).toBe(REASONING_OFF);
    expect(canonicalVariant([], REASONING_OFF)).toBe(REASONING_OFF);
  });

  test('a genuinely unknown level stays unavailable, and default still means "send none"', () => {
    expect(canonicalVariant(['low', 'high'], 'medium')).toBeUndefined();
    expect(canonicalVariant(['low', 'high'], 'default')).toBe('');
    expect(sameVariant(REASONING_OFF, 'OFF')).toBe(true);
  });

  test('an empty model catalogue on cold-start does not report the selected model as unavailable', () => {
    expect(resolveComposerModel('anthropic/claude-sonnet-4-5', 'high', [], null)).toEqual({
      model: undefined,
      error: null,
    });
  });
});
